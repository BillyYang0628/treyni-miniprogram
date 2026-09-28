const aiAdapter = require('./aiAdapter')
const knowledge = require('./knowledge')
const { restInfo } = require('./transplantRest')
const { buildRecentActivity } = require('./recentActivity')
const { getCareRule, getEnvironment, searchDocs } = knowledge

// 会话压缩阈值：超过这个条数就把较早的对话压缩成摘要
const COMPACT_THRESHOLD = 16
const KEEP_RECENT = 8

const CARE_TYPES = ['watering', 'fertilizing', 'pesticide', 'pruning']

function getOrCreateSession(db, plantId, userId, plant) {
  let session = db
    .prepare('SELECT * FROM chat_sessions WHERE plant_id = ? AND user_id = ?')
    .get(plantId, userId)

  if (session) return session

  const greeting = buildGreeting(db, plant)
  const result = db
    .prepare('INSERT INTO chat_sessions (plant_id, user_id, greeting) VALUES (?, ?, ?)')
    .run(plantId, userId, greeting)

  return db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(result.lastInsertRowid)
}

/** 宽松解析用户填写的日期：支持 2026-09-13、2026/9/13、9.13、9-13 */
function parsePlantingDate(value) {
  const raw = String(value || '').trim()
  if (!raw) return null

  const full = raw.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/)
  if (full) {
    const date = new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]))
    return isNaN(date.getTime()) ? null : date
  }

  const short = raw.match(/^(\d{1,2})[-/.月](\d{1,2})/)
  if (short) {
    const now = new Date()
    const date = new Date(now.getFullYear(), Number(short[1]) - 1, Number(short[2]))
    return isNaN(date.getTime()) ? null : date
  }

  return null
}

/** 开场白用真实数据拼，打开会话就不用等 AI */
function buildGreeting(db, plant) {
  const planted = parsePlantingDate(plant.planting_date)
  let days = null

  if (planted) {
    const today = new Date()
    const start = new Date(planted.getFullYear(), planted.getMonth(), planted.getDate())
    const now = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    days = Math.max(0, Math.round((now - start) / 86400000))
  }

  const reminders = db
    .prepare(`
      SELECT type, interval_days FROM plant_reminders
      WHERE plant_id = ? AND status = 'pending'
        AND type IN ('watering', 'fertilizing', 'pesticide', 'pruning')
      ORDER BY due_at ASC LIMIT 4
    `)
    .all(plant.id)

  const label = { watering: '浇水', fertilizing: '施肥', pesticide: '打药', pruning: '修剪' }
  const rhythm = reminders
    .filter((item) => item.interval_days)
    .map((item) => `${label[item.type]}每 ${item.interval_days} 天`)
    .join('、')

  const parts = [`我是托蕾妮，专门照顾你家这盆${plant.species || '植物'}的。`]

  const stage = plant.growth_stage ? `它现在是${plant.growth_stage}` : ''
  if (stage && days !== null) {
    parts.push(`${stage}，你从 ${planted.getMonth() + 1} 月 ${planted.getDate()} 日开始养它，到今天 ${days} 天。`)
  } else if (stage) {
    parts.push(`${stage}。`)
  } else if (days !== null) {
    parts.push(`你养它到今天 ${days} 天了。`)
  }

  // 刚换盆移栽的，先说清缓苗期不能施肥
  const rest = restInfo(plant)
  if (rest.active) {
    parts.push('刚换过盆或刚移栽，两周内属于缓苗期，先不施肥、少折腾，放散光通风处缓一缓，' +
      `到 ${rest.untilText} 之后再施肥。`)
  } else if (Number(plant.is_recent_transplant)) {
    parts.push('刚换盆时的那段缓苗期已经过去了，现在可以按正常节奏养护。')
  }

  if (rhythm) parts.push(`现在的养护节奏是：${rhythm}。`)

  parts.push('你可以直接问我叶片发黄、浇水施肥的问题，也可以让我帮你改档案或调整提醒频率，我改之前都会先问你一声。')

  return parts.join('')
}

function listMessages(db, sessionId, limit = 40) {
  const rows = db
    .prepare(`
      SELECT role, content, created_at FROM chat_messages
      WHERE session_id = ? ORDER BY id DESC LIMIT ?
    `)
    .all(sessionId, limit)

  return rows.reverse()
}

function appendMessage(db, session, role, content) {
  db.prepare(`
    INSERT INTO chat_messages (session_id, plant_id, user_id, role, content)
    VALUES (?, ?, ?, ?, ?)
  `).run(session.id, session.plant_id, session.user_id, role, content)

  db.prepare("UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?").run(session.id)
}

function countMessages(db, sessionId) {
  return db.prepare('SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = ?').get(sessionId).c
}

/** 汇总植物档案、当前提醒和知识库命中 */
function buildContext(db, plant, userMessage) {
  const profile = {
    name: plant.name,
    species: plant.species,
    variety: plant.variety || '',
    pot_size: plant.pot_size || '',
    soil_type: plant.soil_type || '',
    location: plant.location || '',
    light_environment: plant.light_environment || '',
    planting_date: plant.planting_date || '',
    growth_stage: plant.growth_stage || '',
    plant_source: plant.plant_source || '',
    notes: plant.notes || ''
  }

  const reminders = db
    .prepare(`
      SELECT type, title, interval_days, due_at, summary_text, meta_json FROM plant_reminders
      WHERE plant_id = ? AND status = 'pending'
      ORDER BY due_at ASC LIMIT 8
    `)
    .all(plant.id)

  // 浇水节奏以天气模型为准：把模型算出的数字一并交给 AI，避免它自己编间隔
  const wateringReminder = reminders.find((item) => item.type === 'watering')
  let watering = null
  if (wateringReminder && wateringReminder.meta_json) {
    try {
      const meta = JSON.parse(wateringReminder.meta_json) || {}
      if (meta.water) {
        watering = {
          next_due_date: meta.water.next_due_date || '',
          interval_days: meta.water.interval_days || null,
          model_interval_days: meta.water.model_interval_days || null,
          knowledge_interval_days: meta.water.knowledge_interval_days || null,
          corrected: Boolean(meta.water.corrected),
          et0: meta.water.et0 || null,
          city: meta.water.city || '',
          exposure: meta.water.exposure || '',
          soil: meta.water.soil || '',
          tank_percent: meta.water.tank_percent
        }
      }
    } catch (e) {
      watering = null
    }
  }

  const careRules = CARE_TYPES
    .map((type) => {
      const rule = getCareRule(plant.species, type)
      if (!rule) return null
      return {
        type,
        library: rule.libraryLabel,
        interval_days: rule.interval_days,
        note: rule.note,
        detail: String(rule.detail || '').slice(0, 400)
      }
    })
    .filter(Boolean)

  // 从用户问题里找相关知识点
  const disease = knowledge.findDisease(userMessage)
  const purpose = knowledge.findFertilizingPurpose(userMessage)
  const docs = searchDocs([plant.species, userMessage].filter(Boolean), 3)
  const environment = getEnvironment(plant.species)
  const rest = restInfo(plant)

  // 「最近发生的事」：已完成提醒（含用户当时勾的"实际用了什么"）+ 养护日记。
  // 块 4 之前对话完全看不到这些——用户刚在完成面板勾了「花多多1号」，
  // 转头问"我上次施肥用的是什么"，托蕾妮只能回答"我查不到"。
  // 和"排下一轮提醒"共用 recentActivity，两处口径必须一致。
  const recentActivity = buildRecentActivity(db, plant.id, { journalLimit: 6, completionLimit: 5 })

  return {
    profile,
    reminders,
    watering,
    careRules,
    disease,
    purpose,
    docs,
    environment,
    recentActivity,
    transplant: {
      flagged: Boolean(Number(plant.is_recent_transplant)),
      active: rest.active,
      until: rest.until ? rest.until.toISOString().slice(0, 10) : '',
      untilText: rest.untilText
    }
  }
}

/** 去重键：同一项变更只问一次 */
function changeKey(change) {
  return [
    change.change_type,
    change.change_type === 'reminder' ? change.reminder_type : change.field,
    String(change.value === undefined ? change.interval_days : change.value)
  ].join('|')
}

/** 保存 AI 提出的待确认变更（同一项不重复询问） */
function savePendingChanges(db, plant, session, changes) {
  const saved = []
  const now = new Date().toISOString()

  for (const change of changes || []) {
    const key = changeKey(change)

    const exists = db
      .prepare(`
        SELECT id FROM plant_pending_changes
        WHERE plant_id = ? AND change_type = ? AND proposed_fields_json LIKE ?
          AND status IN ('pending', 'applied', 'rejected')
        LIMIT 1
      `)
      .get(plant.id, change.change_type, '%"dedupe_key":"' + key + '"%')

    if (exists) continue

    const payload = JSON.stringify({ ...change, dedupe_key: key, session_id: session ? session.id : null })
    const result = db
      .prepare(`
        INSERT INTO plant_pending_changes (plant_id, user_id, change_type, proposed_fields_json, status)
        VALUES (?, ?, ?, ?, 'pending')
      `)
      .run(plant.id, plant.user_id, change.change_type, payload)

    saved.push(mapPendingChange(db.prepare('SELECT * FROM plant_pending_changes WHERE id = ?').get(result.lastInsertRowid)))
  }

  return saved
}

function mapPendingChange(row) {
  if (!row) return null

  let fields = {}
  try {
    fields = JSON.parse(row.proposed_fields_json) || {}
  } catch (e) {
    fields = {}
  }

  return {
    id: row.id,
    plant_id: row.plant_id,
    change_type: row.change_type,
    status: row.status,
    fields,
    label: fields.label || '',
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

function listPendingChanges(db, plantId, status) {
  const rows = status
    ? db.prepare('SELECT * FROM plant_pending_changes WHERE plant_id = ? AND status = ? ORDER BY id DESC').all(plantId, status)
    : db.prepare('SELECT * FROM plant_pending_changes WHERE plant_id = ? ORDER BY id DESC').all(plantId)

  return rows.map(mapPendingChange)
}

function setPendingChangeStatus(db, changeId, status) {
  db.prepare("UPDATE plant_pending_changes SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, changeId)
}

/**
 * 执行一条被用户确认的变更。
 * 档案字段直接更新；提醒类型的调整会删掉该类型未完成的提醒并按新间隔重建。
 */
function applyChange(db, plant, change) {
  const fields = change.fields || {}

  if (change.change_type === 'profile') {
    const allowed = ['variety', 'pot_size', 'soil_type', 'location', 'light_environment', 'notes', 'planting_date']
    if (!allowed.includes(fields.field)) {
      const err = new Error('不支持的档案字段：' + fields.field)
      err.code = 'UNSUPPORTED_PROFILE_FIELD'
      err.status = 400
      throw err
    }

    db.prepare(`UPDATE plants SET ${fields.field} = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(String(fields.value || ''), plant.id)

    return {
      change_type: 'profile',
      field: fields.field,
      value: fields.value,
      label: fields.label || `把${fields.field}改成${fields.value}`
    }
  }

  if (change.change_type === 'reminder') {
    const type = fields.reminder_type
    const intervalDays = Number(fields.interval_days)

    if (!CARE_TYPES.includes(type) || !Number.isFinite(intervalDays) || intervalDays < 1 || intervalDays > 180) {
      const err = new Error('不支持的提醒调整')
      err.code = 'UNSUPPORTED_REMINDER_CHANGE'
      err.status = 400
      throw err
    }

    const removed = db
      .prepare("DELETE FROM plant_reminders WHERE plant_id = ? AND type = ? AND status = 'pending'")
      .run(plant.id, type)

    const dueAt = new Date(Date.now() + intervalDays * 24 * 60 * 60 * 1000).toISOString()
    const rule = getCareRule(plant.species, type)
    const title = { watering: '浇水', fertilizing: '施肥', pesticide: '打药', pruning: '修剪' }[type]
    const { buildReminderSummary } = require('./reminderText')

    const inserted = db
      .prepare(`
        INSERT INTO plant_reminders (
          plant_id, user_id, type, title, content, summary_text, detail_content,
          ai_model, due_at, interval_days, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `)
      .run(
        plant.id,
        plant.user_id,
        type,
        title,
        rule && rule.detail ? rule.detail : '按新间隔执行养护',
        buildReminderSummary({ type, title }, plant.name) + `（每 ${intervalDays} 天）`,
        rule ? rule.detail : null,
        rule ? rule.library : null,
        dueAt,
        intervalDays
      )

    db.prepare(`
      INSERT INTO plant_journal (plant_id, user_id, type, content)
      VALUES (?, ?, 'custom', ?)
    `).run(plant.id, plant.user_id, `通过 AI 精灵调整：${title}改为每 ${intervalDays} 天一次`)

    return {
      change_type: 'reminder',
      reminder_type: type,
      interval_days: intervalDays,
      removed_reminders: removed.changes,
      created_reminder_id: Number(inserted.lastInsertRowid),
      label: fields.label || `把${title}改成每 ${intervalDays} 天一次`
    }
  }

  const err = new Error('不支持的变更类型：' + change.change_type)
  err.code = 'UNSUPPORTED_CHANGE_TYPE'
  err.status = 400
  throw err
}

/**
 * 对话历史压缩：条数超过阈值时，把较早的消息交给 AI 总结。
 */
async function compressIfNeeded(db, session) {
  const total = countMessages(db, session.id)
  if (total <= COMPACT_THRESHOLD) return null

  const rows = db
    .prepare(`
      SELECT id, role, content FROM chat_messages
      WHERE session_id = ? ORDER BY id ASC LIMIT ?
    `)
    .all(session.id, total - KEEP_RECENT)

  if (!rows.length) return null

  const summary = await aiAdapter.summarizeChat(session.summary || '', rows)

  db.prepare('UPDATE chat_sessions SET summary = ?, compact_history_json = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(summary, JSON.stringify(rows.slice(-20)), session.id)

  db.prepare(`DELETE FROM chat_messages WHERE id IN (${rows.map((row) => row.id).join(',')})`).run()

  return summary
}

module.exports = {
  CARE_TYPES,
  COMPACT_THRESHOLD,
  getOrCreateSession,
  buildGreeting,
  listMessages,
  appendMessage,
  countMessages,
  buildContext,
  savePendingChanges,
  mapPendingChange,
  listPendingChanges,
  setPendingChangeStatus,
  applyChange,
  compressIfNeeded
}
