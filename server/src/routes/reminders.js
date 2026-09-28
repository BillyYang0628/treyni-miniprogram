const express = require('express')
const crypto = require('node:crypto')
const { getDb } = require('../db')
const { requireAuth } = require('../middleware/auth')
const { createNextReminder } = require('../services/defaultReminders')
const {
  createTreatmentPair,
  createInitialTreatmentPair,
  collectCycleRounds,
  parseMeta,
  diseaseFromTitle
} = require('../services/treatment')
const { buildReminderSummary, buildDueLabel, buildDueText, daysUntilDue } = require('../services/reminderText')
const aiAdapter = require('../services/aiAdapter')
const nextReminderService = require('../services/nextReminder')
const waterPlan = require('../services/waterPlan')
const waterBaseline = require('../services/waterBaseline')
const undoStore = require('../services/undoStore')
const reminderTiming = require('../services/reminderTiming')
const transplantRest = require('../services/transplantRest')
const planService = require('../services/plan')
const { TYPE_LABEL: TYPE_LABEL_FOR_PLAN } = require('../services/reminderText')
const { LATE_REASON_LABEL } = require('../services/reminderText')
const speciesOptions = require('../services/speciesOptions')

const router = express.Router()

const AI_DETAIL_TYPES = ['watering', 'fertilizing', 'pesticide', 'pruning']

router.use(requireAuth)

function getOwnedPlant(db, plantId, userId) {
  return db
    .prepare('SELECT * FROM plants WHERE id = ? AND user_id = ?')
    .get(plantId, userId)
}

function baseReminderFields(row) {
  let meta = {}
  if (row.meta_json) {
    try {
      meta = JSON.parse(row.meta_json)
    } catch (e) {
      meta = {}
    }
  }

  // 方案级候选 + 实时问题（第 5 期）
  let planOptions = { options: [], ask: '' }
  try {
    const parsed = row.options_json ? JSON.parse(row.options_json) : null
    if (parsed && Array.isArray(parsed.options)) {
      planOptions = { options: parsed.options, ask: parsed.ask || '' }
    }
  } catch (e) {
    planOptions = { options: [], ask: '' }
  }

  // 逾期天数给前端上色用（边框从近黑渐变到明红，7 天封顶）。
  // 放在服务端算，保证列表和详情用的是同一个口径，不要各自 new Date 一遍。
  const dueDiff = daysUntilDue(row.due_at)

  return {
    id: row.id,
    plant_id: row.plant_id,
    type: row.type,
    title: row.title,
    summary_text: row.summary_text || row.title || '',
    due_at: row.due_at,
    due_label: buildDueLabel(row.due_at),
    due_text: buildDueText(row.due_at),
    days_until_due: dueDiff,
    late_days: dueDiff === null ? 0 : Math.max(0, -dueDiff),
    // 档位（太早 / 略早 / 正常 / 略逾期 / 明显逾期）。
    // 优先读冻结在 meta.timing 上的阈值；没冻结就现算，前端不用自己算。
    timing: reminderTiming.evaluate(row),
    // 这次做了什么的候选（方案级）；物种级在 care_options 里
    options: planOptions.options,
    ask: planOptions.ask,
    interval_days: row.interval_days || null,
    status: row.status,
    completed_at: row.completed_at || '',
    related_reminder_id: row.related_reminder_id || null,
    treatment_round: row.treatment_round || null,
    has_detail: Boolean(row.detail_content && String(row.detail_content).trim()),
    is_ai: Boolean(row.ai_generated_at),
    ai_status: row.ai_status || '',
    ai_error: row.ai_error || '',
    ai_reason: row.ai_reason || '',
    // detail_source：daily_care / fertilizing / pesticide 表示来自对应知识库，ai 表示 AI 生成
    detail_source: row.ai_model === 'water_model' || row.ai_model === 'water_model+ai'
      ? 'water_model'
      : (row.ai_generated_at
          ? 'ai'
          : (['daily_care', 'fertilizing', 'pesticide'].includes(row.ai_model)
              ? row.ai_model
              : (row.ai_model === 'knowledge' ? 'daily_care' : ''))),
    meta,
    water: meta.water || null,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

// 列表只需要摘要，不带完整详情，避免响应过大
function mapReminderForList(row) {
  return baseReminderFields(row)
}

// 详情页需要完整内容
function mapReminder(row) {
  return {
    ...baseReminderFields(row),
    content: row.content || '',
    detail_content: row.detail_content || ''
  }
}

/**
 * 把一行提醒原样写回。
 * 撤销用——整行恢复比逐字段回滚可靠，以后加字段也不会漏。
 */
function restoreReminderRow(db, row) {
  const columns = Object.keys(row).filter((name) => name !== 'id')
  if (!columns.length) return
  const sql = 'UPDATE plant_reminders SET ' + columns.map((name) => name + ' = ?').join(', ') + ' WHERE id = ?'
  db.prepare(sql).run(...columns.map((name) => row[name]), row.id)
}

function finishReminder(db, reminder, options = {}) {
  const now = new Date().toISOString()
  // 实际做这件事的日期（用户可在完成面板里改，默认今天）。
  // 下一轮从这天起算，而不是从"点完成那一刻"起算。
  const occurredAt = options.occurredAt || now.slice(0, 10)

  // 默认 completed；「其实已经做过了」这种情况标成 skipped——
  // 它不算一次真实的养护动作，所以不写养护历程、不记浇水事件。
  db.prepare(`
    UPDATE plant_reminders
    SET status = ?, completed_at = ?, updated_at = ?
    WHERE id = ?
  `).run(options.status || 'completed', now, now, reminder.id)

  let nextReminder = null
  // 「暂不需要做」时用户确认过要拉长间隔，就用拉长后的值建下一轮
  const intervalForNext = Number(options.intervalOverride) > 0
    ? Number(options.intervalOverride)
    : Number(reminder.interval_days)
  if (intervalForNext > 0) {
    nextReminder = createNextReminder(db, { ...reminder, interval_days: intervalForNext }, { occurredAt })
  }

  // 下一轮提醒交给 AI 结合档案、知识库和历史记录调整（后台执行，失败会显式标记）
  if (nextReminder && nextReminderService.isCareType(nextReminder.type)) {
    if (nextReminder.type === 'watering') {
      // 先把水分基准按"实际浇水的日期"写成刚浇透，天气模型再从这天往后推，
      // 下一轮自然就落在「实际日期 + 间隔」。顺序不能反。
      waterPlan.writeBaseline(db, nextReminder.id, 'soaked', occurredAt, 'completion')
      // 浇水：先由天气系数模型算日期（含降雨重置），再交给 AI 写文案。
      // 两步都在后台执行，间隔与日期始终以天气模型为准。
      nextReminderService.markPending(db, nextReminder.id)
      waterPlan.applyToReminder(nextReminder.id)
        .then(() => nextReminderService.scheduleAdviceInBackground(db, nextReminder.id))
        .catch((err) => {
          console.warn('[water] 浇水提醒计算失败：' + err.message)
          try {
            nextReminderService.markFailed(db, nextReminder.id, err.message)
          } catch (e) {
            console.warn('[water] 写入失败状态时出错：' + e.message)
          }
        })
    } else {
      nextReminderService.scheduleAdviceInBackground(db, nextReminder.id)
    }
    nextReminder = db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(nextReminder.id)
  }

  const completed = db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(reminder.id)
  return {
    completed,
    nextReminder,
    occurredAt
  }
}

router.get('/plants/:id/reminders', (req, res) => {
  const db = getDb()
  const plant = getOwnedPlant(db, req.params.id, req.user.id)

  if (!plant) {
    return res.status(404).json({
      error: '植物不存在',
      code: 'PLANT_NOT_FOUND'
    })
  }

  const reminders = db
    .prepare('SELECT * FROM plant_reminders WHERE plant_id = ? ORDER BY status = ? DESC, due_at ASC')
    .all(plant.id, 'pending')

  // 懒回填：老数据没有 meta.timing，第一次读到就按当时的间隔冻结一份
  for (const row of reminders) {
    if (row.status === 'pending') {
      try {
        reminderTiming.ensureTiming(db, row.id)
      } catch (e) {
        console.warn('[timing] 冻结阈值失败 #' + row.id + '：' + e.message)
      }
    }
  }

  res.json({
    reminders: reminders.map((row) => ({
      ...mapReminderForList(row),
      // 完成面板"这次实际用了什么"的候选（物种级缓存；没有就空数组，前端会退回兜底）
      care_options: speciesOptions.optionsFor(plant.species, row.type)
    }))
  })
})

router.post('/plants/:id/reminders', (req, res) => {
  const db = getDb()
  const plant = getOwnedPlant(db, req.params.id, req.user.id)

  if (!plant) {
    return res.status(404).json({
      error: '植物不存在',
      code: 'PLANT_NOT_FOUND'
    })
  }

  const type = req.body && req.body.type
  const title = req.body && req.body.title
  const content = req.body && req.body.content
  const intervalDays = Number(req.body && req.body.interval_days)
  const dueAt = req.body && req.body.due_at

  if (!type || !title) {
    return res.status(400).json({
      error: '提醒类型和标题为必填项',
      code: 'MISSING_REMINDER_FIELDS'
    })
  }

  const effectiveInterval = Number.isFinite(intervalDays) && intervalDays > 0 ? intervalDays : null
  const dueDate = dueAt
    ? new Date(dueAt).toISOString()
    : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  const summary = buildReminderSummary({ type, title }, plant.name)

  const result = db
    .prepare(`
      INSERT INTO plant_reminders (
        plant_id, user_id, type, title, content, summary_text, due_at, interval_days, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `)
    .run(plant.id, req.user.id, type, title, content || '', summary, dueDate, effectiveInterval)

  reminderTiming.freezeTiming(db, result.lastInsertRowid)

  const reminder = db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(result.lastInsertRowid)
  res.status(201).json({ reminder: mapReminder(reminder) })
})

/**
 * 完成回执造句（B-2，2026-09-20）。
 *
 * 完成面板把勾选项发成一条「我」的气泡，这里只负责把那串选项说成一句人话。
 * 三条设计约束：
 *   1. **不写库、不改任何状态**——它只是气泡的文案；
 *   2. **失败静默**：AI 没配 / 超时就返回空字符串，前端用本地拼接的那句，
 *      用户看不到"AI 造句失败"这种东西（这是动画，不是功能）；
 *   3. 前端只等 1.5 秒，所以这里不重试、不排队。
 */
router.post('/reminders/:id/echo', async (req, res, next) => {
  try {
    const db = getDb()
    const reminder = db
      .prepare('SELECT * FROM plant_reminders WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id)

    if (!reminder) {
      return res.status(404).json({
        error: '提醒不存在',
        code: 'REMINDER_NOT_FOUND'
      })
    }

    const items = (Array.isArray(req.body && req.body.items) ? req.body.items : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 8)

    if (!items.length) return res.json({ text: '' })

    const plant = db.prepare('SELECT * FROM plants WHERE id = ?').get(reminder.plant_id)
    let text = ''

    try {
      text = await aiAdapter.echoCompletion({
        type: reminder.type,
        species: plant && plant.species,
        items
      })
    } catch (err) {
      // 静默：气泡是动画，AI 不来就用前端拼的那句
      console.warn('[reminder.echo] 造句失败：' + err.message)
    }

    res.json({ text })
  } catch (err) {
    next(err)
  }
})

// 提醒详情：列表点进来时读取完整内容
router.get('/reminders/:id', (req, res) => {
  const db = getDb()
  const reminder = db
    .prepare('SELECT * FROM plant_reminders WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id)

  if (!reminder) {
    return res.status(404).json({
      error: '提醒不存在',
      code: 'REMINDER_NOT_FOUND'
    })
  }

  const plant = db.prepare('SELECT * FROM plants WHERE id = ?').get(reminder.plant_id)
  const related = reminder.related_reminder_id
    ? db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(reminder.related_reminder_id)
    : null

  // 懒回填阈值（老数据没有 meta.timing）
  if (reminder.status === 'pending') {
    try {
      reminderTiming.ensureTiming(db, reminder.id)
      // 顺便把物种级候选也备上（异步，不挡这次请求）
      speciesOptions.ensureInBackground(plant ? plant.species : '')
    } catch (e) {
      console.warn('[timing] 冻结阈值失败 #' + reminder.id + '：' + e.message)
    }
  }

  res.json({
    reminder: {
      ...mapReminder(db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(reminder.id)),
      care_options: speciesOptions.optionsFor(plant ? plant.species : '', reminder.type)
    },
    related_reminder: related
      ? {
          id: related.id,
          type: related.type,
          title: related.title,
          summary_text: related.summary_text || related.title,
          detail_content: related.detail_content || related.content || '',
          status: related.status,
          due_text: buildDueText(related.due_at),
          treatment_round: related.treatment_round || null
        }
      : null,
    plant: plant
      ? {
          id: plant.id,
          name: plant.name,
          species: plant.species,
          variety: plant.variety || ''
        }
      : null
  })
})

/**
 * 重新生成“下一轮提醒”的 AI 建议。
 * 用于自动生成失败后的重试，也可以由用户主动触发。
 */
router.post('/reminders/:id/ai-advice', async (req, res, next) => {
  try {
    const db = getDb()
    const reminder = db
      .prepare('SELECT * FROM plant_reminders WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id)

    if (!reminder) {
      return res.status(404).json({
        error: '提醒不存在',
        code: 'REMINDER_NOT_FOUND'
      })
    }

    if (!nextReminderService.isCareType(reminder.type)) {
      return res.status(400).json({
        error: '该提醒类型不需要 AI 安排下一轮',
        code: 'AI_ADVICE_UNSUPPORTED'
      })
    }

    nextReminderService.markPending(db, reminder.id)

    try {
      // 浇水提醒：先把天气模型重算一遍（可能已经过去几天、或下过雨），再让 AI 写文案
      if (reminder.type === 'watering') {
        await waterPlan.applyToReminder(reminder.id)
      }
      await nextReminderService.generateAdvice(db, reminder.id)
    } catch (err) {
      nextReminderService.markFailed(db, reminder.id, err.message)
      throw err
    }

    const updated = db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(reminder.id)
    res.json({ reminder: mapReminder(updated), regenerated: true })
  } catch (err) {
    next(err)
  }
})

// 生成（或重新生成）提醒的完整操作方案
router.post('/reminders/:id/detail', async (req, res, next) => {
  try {
    const db = getDb()
    const reminder = db
      .prepare('SELECT * FROM plant_reminders WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id)

    if (!reminder) {
      return res.status(404).json({
        error: '提醒不存在',
        code: 'REMINDER_NOT_FOUND'
      })
    }

    const force = Boolean(req.body && req.body.force)
    const hasDetail = Boolean(reminder.detail_content && String(reminder.detail_content).trim())

    if (hasDetail && !force) {
      return res.json({ reminder: mapReminder(reminder), generated: false })
    }

    // 只有浇水、施肥、修剪需要按植物档案生成方案，
    // 用药提醒在诊断时已经生成，手动提醒直接用用户填写的内容
    if (!AI_DETAIL_TYPES.includes(reminder.type)) {
      return res.json({
        reminder: mapReminder(reminder),
        generated: false,
        message: '该提醒类型不需要 AI 生成详细方案'
      })
    }

    const plant = db.prepare('SELECT * FROM plants WHERE id = ?').get(reminder.plant_id)
    if (!plant) {
      return res.status(404).json({
        error: '植物不存在',
        code: 'PLANT_NOT_FOUND'
      })
    }

    const feedback = String((req.body && req.body.feedback) || '').slice(0, 300)

    // 用户在反馈里描述了土壤状态（例如「现在土壤是刚浇过水的状态」）就据此更新水分基准。
    // 以前这段话只进提示词，不会碰水分估算，用户填了等于没填（见水分解那两条清单）。
    let baselineNote = ''
    const detected = reminder.type === 'watering' ? waterBaseline.detectLevel(feedback) : null
    if (detected) {
      try {
        await waterPlan.setWaterBaseline(reminder.id, detected.level, 'feedback')
        baselineNote = '已按你说的把土壤水分更新成「' + detected.label + '」，下次浇水日期重新算过了。'
      } catch (err) {
        console.warn('[water] 按反馈更新水分基准失败：' + err.message)
      }
    }

    const detail = await aiAdapter.generateCareDetail(plant, reminder, { feedback })
    const now = new Date().toISOString()

    // 块 3（2026-09-21）：这条链路现在也会产出「方案级候选 + 一句实时问题」。
    // 只有真的产出了才写 options_json —— 模型没守 JSON 格式时（候选为空）
    // 不要把「下一轮提醒」那条链路已经写好的候选抹掉。
    const hasPlanOptions = detail.options.length > 0 || detail.ask
    if (hasPlanOptions) {
      db.prepare(`
        UPDATE plant_reminders
        SET detail_content = ?, options_json = ?, ai_model = ?, ai_generated_at = ?, updated_at = ?
        WHERE id = ?
      `).run(detail.detail, JSON.stringify({ options: detail.options, ask: detail.ask }),
        'kimi', now, now, reminder.id)
    } else {
      db.prepare(`
        UPDATE plant_reminders
        SET detail_content = ?, ai_model = ?, ai_generated_at = ?, updated_at = ?
        WHERE id = ?
      `).run(detail.detail, 'kimi', now, now, reminder.id)
    }

    const updated = db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(reminder.id)
    res.json({ reminder: mapReminder(updated), generated: true, baseline_note: baselineNote })
  } catch (err) {
    next(err)
  }
})

/**
 * 设置土壤水分基准。
 * 用户第一次点进浇水提醒详情时，让他自己描述现在土壤什么状态，
 * 而不是让模型默认「今天刚浇透」——见 services/waterBaseline.js 的说明。
 */
router.post('/reminders/:id/water-baseline', async (req, res, next) => {
  try {
    const db = getDb()
    const reminder = db
      .prepare('SELECT * FROM plant_reminders WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id)

    if (!reminder) {
      return res.status(404).json({ error: '提醒不存在', code: 'REMINDER_NOT_FOUND' })
    }

    const level = String((req.body && req.body.level) || '')
    const result = await waterPlan.setWaterBaseline(reminder.id, level, 'user')

    if (!result.ok) {
      return res.status(400).json({ error: result.error, code: 'WATER_BASELINE_INVALID' })
    }

    const updated = db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(reminder.id)
    res.json({ reminder: mapReminder(updated), baseline: result.baseline, levels: waterBaseline.LEVELS })
  } catch (err) {
    next(err)
  }
})

router.post('/plants/:id/quick-action', (req, res) => {
  const db = getDb()
  const plant = getOwnedPlant(db, req.params.id, req.user.id)

  if (!plant) {
    return res.status(404).json({
      error: '植物不存在',
      code: 'PLANT_NOT_FOUND'
    })
  }

  const type = req.body && req.body.type
  const content = req.body && req.body.content

  if (!type) {
    return res.status(400).json({
      error: '养护动作类型不能为空',
      code: 'ACTION_TYPE_REQUIRED'
    })
  }

  const journalResult = db
    .prepare(`
      INSERT INTO plant_journal (plant_id, user_id, type, content)
      VALUES (?, ?, ?, ?)
    `)
    .run(plant.id, req.user.id, type, content || '完成一次养护动作')

  const pendingReminder = db
    .prepare(`
      SELECT * FROM plant_reminders
      WHERE plant_id = ? AND user_id = ? AND type = ? AND status = 'pending'
      ORDER BY due_at ASC
      LIMIT 1
    `)
    .get(plant.id, req.user.id, type)

  let completedReminder = null
  let nextReminder = null

  if (pendingReminder) {
    const finished = finishReminder(db, pendingReminder)
    completedReminder = finished.completed
    nextReminder = finished.nextReminder
  }

  res.status(201).json({
    journal: {
      id: Number(journalResult.lastInsertRowid),
      plant_id: plant.id,
      type,
      content: content || '完成一次养护动作',
      created_at: new Date().toISOString()
    },
    completed_reminder: completedReminder ? mapReminder(completedReminder) : null,
    next_reminder: nextReminder ? mapReminder(nextReminder) : null
  })
})

router.post('/reminders/:id/complete', (req, res) => {
  const db = getDb()
  const reminder = db
    .prepare('SELECT * FROM plant_reminders WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id)

  if (!reminder) {
    return res.status(404).json({
      error: '提醒不存在',
      code: 'REMINDER_NOT_FOUND'
    })
  }

  // 完成面板收集到的信息（第一期先原样存下来；第二期起 occurred_at 会参与算下一轮）
  const body = req.body || {}
  const occurredAt = String(body.occurred_at || '').slice(0, 10)
  const doneItems = Array.isArray(body.done_items)
    ? body.done_items.map((item) => String(item).slice(0, 40)).filter(Boolean).slice(0, 8)
    : []
  const completionNote = String(body.note || '').trim().slice(0, 200)
  const unsure = Boolean(body.unsure)
  const lateReason = String(body.late_reason || '').slice(0, 24)
  const lateNote = String(body.late_note || '').trim().slice(0, 200)
  // 「其实已经做过了」：这条提醒是重复的 → 标记跳过，不写养护历程、不记浇水事件
  const alreadyDone = lateReason === 'already_done'
  // 「暂不需要做」时前端问过要不要拉长间隔，确认了就把间隔翻倍（有上下限）
  const extendInterval = Boolean(body.extend_interval)
  const baseInterval = Number(reminder.interval_days) || 7
  const intervalOverride = extendInterval
    ? Math.min(180, Math.max(2, Math.round(baseInterval * 2)))
    : null

  // 完成之前把整行存快照，撤销时原样写回（见 services/undoStore.js）
  const snapshotRow = reminder
  const { completed, nextReminder } = finishReminder(db, reminder, {
    occurredAt,
    status: alreadyDone ? 'skipped' : 'completed',
    intervalOverride
  })

  // 记录用户实际做了什么。
  // 注意：没选任何一项时记「未登记」，**不能**当成"按方案做了"——那是伪造数据，AI 会当真。
  const detailParts = []
  if (doneItems.length) detailParts.push(doneItems.join('、'))
  if (unsure) detailParts.push('具体做了什么未登记')
  if (completionNote) detailParts.push('备注：' + completionNote)
  // 迟做的原因写进养护历程，下一次 AI 排期时能看到（buildHistory 读的就是这里）
  if (lateReason && !alreadyDone) {
    const label = LATE_REASON_LABEL[lateReason] || lateReason
    detailParts.push('这次晚了的原因：' + label + (lateNote ? '（' + lateNote + '）' : ''))
  }
  const journalContent = detailParts.length
    ? `完成提醒：${reminder.title}｜${detailParts.join('｜')}`
    : `完成提醒：${reminder.title}`

  if (body.occurred_at !== undefined || body.done_items !== undefined || completionNote || unsure) {
    let meta = {}
    try {
      meta = reminder.meta_json ? JSON.parse(reminder.meta_json) : {}
    } catch (e) {
      meta = {}
    }
    meta.completion = {
      occurred_at: occurredAt || new Date().toISOString().slice(0, 10),
      done_items: doneItems,
      unsure,
      note: completionNote,
      late_reason: lateReason,
      late_note: lateNote,
      skipped: alreadyDone,
      at: new Date().toISOString()
    }
    db.prepare('UPDATE plant_reminders SET meta_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(meta), new Date().toISOString(), reminder.id)
  }

  // 浇水完成：记录事件（含实时天气快照），作为下次计算的起点
  // 「已经做过了」不算这次浇的水，所以不记事件
  if (reminder.type === 'watering' && !alreadyDone) {
    const plant = db.prepare('SELECT * FROM plants WHERE id = ?').get(reminder.plant_id)
    if (plant) {
      waterPlan.recordWateringEvent(plant, reminder.user_id, '完成浇水提醒').catch((err) => {
        console.warn('[water] 记录浇水事件失败：' + err.message)
      })
    }
  }

  // 「其实已经做过了」是重复提醒，不写养护历程（避免污染历史）
  const journalResult = alreadyDone
    ? null
    : db
        .prepare(`
          INSERT INTO plant_journal (plant_id, user_id, type, content)
          VALUES (?, ?, ?, ?)
        `)
        .run(reminder.plant_id, reminder.user_id, reminder.type, journalContent)
  const journal = journalResult
    ? db.prepare('SELECT * FROM plant_journal WHERE id = ?').get(journalResult.lastInsertRowid)
    : null

  // 撤销凭据：整行快照 + 这次连带产生的记录 id，5 分钟内有效（客户端给用户 5 秒）
  const undoToken = undoStore.put(crypto.randomUUID(), {
    reminder: snapshotRow,
    nextReminderId: nextReminder ? nextReminder.id : null,
    // 「其实已经做过了」不写养护历程，这里要允许为空
    journalId: journal ? journal.id : null,
    plantId: reminder.plant_id,
    type: reminder.type,
    completedAt: completed.completed_at || new Date().toISOString()
  })
  undoStore.sweep()

  res.json({
    reminder: mapReminder(completed),
    next_reminder: nextReminder ? mapReminder(nextReminder) : null,
    occurred_at: occurredAt,
    skipped: alreadyDone,
    interval_days: intervalOverride || null,
    undo_token: undoToken,
    undo_seconds: 5,
    journal: journal ? {
      id: journal.id,
      plant_id: journal.plant_id,
      type: journal.type,
      content: journal.content || '',
      created_at: journal.created_at
    } : null
  })
})

/**
 * 撤销刚才那次完成，整行回滚到点按钮之前的状态。
 *
 * 回滚范围（按 2026-09-18 定的）：
 *   1. 提醒那一行整行写回（状态、completed_at、meta_json 全都回来）
 *   2. 删掉这次连带生成的下一轮提醒
 *   3. 删掉这次写的养护历程
 *   4. 删掉这次补记的浇水事件（否则水分账户会残留一次不存在的浇水）
 * 新提醒上的土壤水分基准跟着"下一轮提醒"一起被删，不用单独处理。
 */
router.post('/reminders/:id/undo-complete', (req, res) => {
  const db = getDb()
  const token = String((req.body && req.body.token) || '')
  const snapshot = undoStore.take(token)

  if (!snapshot) {
    return res.status(410).json({
      error: '撤销时间已过',
      code: 'UNDO_EXPIRED'
    })
  }

  if (String(snapshot.reminder.id) !== String(req.params.id)) {
    return res.status(400).json({
      error: '撤销凭据和提醒对不上',
      code: 'UNDO_MISMATCH'
    })
  }

  if (Number(snapshot.reminder.user_id) !== Number(req.user.id)) {
    return res.status(403).json({
      error: '无权撤销这条提醒',
      code: 'UNDO_FORBIDDEN'
    })
  }

  if (snapshot.nextReminderId) {
    db.prepare('DELETE FROM plant_reminders WHERE id = ?').run(snapshot.nextReminderId)
  }

  if (snapshot.journalId) {
    db.prepare('DELETE FROM plant_journal WHERE id = ?').run(snapshot.journalId)
  }

  if (snapshot.type === 'watering') {
    // 事件是在完成之后异步写入的，所以按"完成时刻往后"删，留 2 秒余量
    const since = new Date(new Date(snapshot.completedAt).getTime() - 2000).toISOString()
    db.prepare(
      'DELETE FROM plant_water_events WHERE plant_id = ? AND note = ? AND happened_at >= ?'
    ).run(snapshot.plantId, '完成浇水提醒', since)
  }

  restoreReminderRow(db, snapshot.reminder)

  const restored = db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(snapshot.reminder.id)
  res.json({ reminder: mapReminder(restored), undone: true })
})

/**
 * 改期：把这条提醒挪到别的日子。
 *
 * 用在完成面板的「只是安排到那天」分支——用户还没做，只是想把日子挪一挪。
 * 它**不完成提醒、不生成下一轮**，只改 due_at（所以不写养护历程。
 * "计划一条养护"是另一个功能，等做「+ 计划」时一起处理）。
 */
router.post('/reminders/:id/reschedule', (req, res) => {
  const db = getDb()
  const reminder = db
    .prepare('SELECT * FROM plant_reminders WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id)

  if (!reminder) {
    return res.status(404).json({ error: '提醒不存在', code: 'REMINDER_NOT_FOUND' })
  }

  if (reminder.status !== 'pending') {
    return res.status(400).json({
      error: '只有待办的提醒可以改期',
      code: 'REMINDER_NOT_PENDING'
    })
  }

  const dueDay = String((req.body && req.body.due_at) || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDay)) {
    return res.status(400).json({
      error: '日期格式不对，要 YYYY-MM-DD',
      code: 'INVALID_DUE_DATE'
    })
  }

  // 落点和其它地方一致：当天 09:00
  const dueAt = new Date(dueDay + 'T09:00:00+08:00')
  if (isNaN(dueAt.getTime())) {
    return res.status(400).json({ error: '日期解析失败', code: 'INVALID_DUE_DATE' })
  }

  const now = new Date().toISOString()
  db.prepare('UPDATE plant_reminders SET due_at = ?, updated_at = ? WHERE id = ?')
    .run(dueAt.toISOString(), now, reminder.id)

  // 日期变了，缓存出来的档位判定要跟着刷新
  reminderTiming.freezeTiming(db, reminder.id)

  const updated = db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(reminder.id)
  res.json({ reminder: mapReminder(updated), rescheduled: true, due_date: dueDay })
})

/**
 * 计划一件事。
 *
 * 四类以内（含换盆）：改对应提醒的日期 —— 等于"安排进每日提醒"。
 *   没有对应提醒时只有换盆会新建一条（其余四类在添加植物时就建好了）。
 * 四类以外：只写一条计划记录，不排提醒、不参与周期。
 *
 * 如果用户往"其他"里填的内容命中了四类关键词，**先不保存**，
 * 返回 need_confirm 让前端问一句，避免把"下周末换盆"默默记成一条普通笔记。
 */
router.post('/plants/:id/plan', (req, res, next) => {
  try {
    const db = getDb()
    const plant = getOwnedPlant(db, req.params.id, req.user.id)
    if (!plant) {
      return res.status(404).json({ error: '植物不存在', code: 'PLANT_NOT_FOUND' })
    }

    const body = req.body || {}
    const kind = String(body.kind || '')
    const dueDay = String(body.due_at || '').slice(0, 10)
    const title = String(body.title || '').trim().slice(0, 60)
    const note = String(body.note || '').trim().slice(0, 200)

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDay)) {
      return res.status(400).json({ error: '日期格式不对，要 YYYY-MM-DD', code: 'INVALID_DUE_DATE' })
    }
    if (!kind) {
      return res.status(400).json({ error: '缺少计划类型', code: 'MISSING_PLAN_KIND' })
    }

    const now = new Date().toISOString()
    const dueAt = new Date(dueDay + 'T09:00:00+08:00')
    if (isNaN(dueAt.getTime())) {
      return res.status(400).json({ error: '日期解析失败', code: 'INVALID_DUE_DATE' })
    }

    // 四类以外：先看文字里有没有四类关键词
    if (kind === 'other') {
      const detected = planService.detectCareKind(title + ' ' + note)
      if (detected && !body.accept_keyword) {
        return res.json({
          need_confirm: true,
          suggestion: detected,
          message: '这条听起来像一次' + detected.label + '，要不要顺便安排进每日提醒？'
        })
      }

      const inserted = db
        .prepare(`
          INSERT INTO plant_journal (plant_id, user_id, type, content, kind, occurred_at)
          VALUES (?, ?, 'custom', ?, 'planned', ?)
        `)
        .run(plant.id, req.user.id, title || note || '计划一件事', dueDay)
      const journal = db.prepare('SELECT * FROM plant_journal WHERE id = ?').get(inserted.lastInsertRowid)
      return res.status(201).json({ journal, plan_kind: 'other', affects_reminders: false, due_date: dueDay })
    }

    if (!planService.affectsReminders(kind)) {
      return res.status(400).json({ error: '不认识的计划类型：' + kind, code: 'UNKNOWN_PLAN_KIND' })
    }

    // 四类以内（含换盆）：找对应的待办提醒改期
    let target = db
      .prepare(`
        SELECT * FROM plant_reminders
        WHERE plant_id = ? AND user_id = ? AND type = ? AND status = 'pending'
        ORDER BY due_at ASC LIMIT 1
      `)
      .get(plant.id, req.user.id, kind)

    let reminderCreated = false
    if (!target && kind === 'repot') {
      // 换盆提醒不在默认提醒里，计划时顺手建一条
      const inserted = db
        .prepare(`
          INSERT INTO plant_reminders (plant_id, user_id, type, title, content, summary_text, due_at, status)
          VALUES (?, ?, 'repot', '换盆', ?, ?, ?, 'pending')
        `)
        .run(
          plant.id,
          req.user.id,
          note || '安排一次换盆',
          buildReminderSummary({ type: 'repot', title: '换盆' }, plant.name),
          dueAt.toISOString()
        )
      reminderTiming.freezeTiming(db, inserted.lastInsertRowid)
      target = db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(inserted.lastInsertRowid)
      reminderCreated = true
    }

    if (target) {
      db.prepare('UPDATE plant_reminders SET due_at = ?, updated_at = ? WHERE id = ?')
        .run(dueAt.toISOString(), now, target.id)
      reminderTiming.freezeTiming(db, target.id)
    }

    const label = TYPE_LABEL_FOR_PLAN[kind] || kind
    const inserted = db
      .prepare(`
        INSERT INTO plant_journal (plant_id, user_id, type, content, kind, occurred_at)
        VALUES (?, ?, ?, ?, 'planned', ?)
      `)
      .run(plant.id, req.user.id, kind, '计划：' + dueDay + ' ' + (title || label), dueDay)
    const journal = db.prepare('SELECT * FROM plant_journal WHERE id = ?').get(inserted.lastInsertRowid)

    res.status(201).json({
      journal,
      plan_kind: kind,
      affects_reminders: Boolean(target),
      reminder_created: reminderCreated,
      reminder: target ? mapReminder(db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(target.id)) : null,
      due_date: dueDay
    })
  } catch (err) {
    next(err)
  }
})

/**
 * 换盆确认（2026-09-18 定的"事件型"）。
 *
 * 换盆没有周期、不该被 AI 排下一轮，所以它是独立的一套流程：
 *   更新花盆/土壤 → 记下换盆日（触发缓苗期）→ 完成这条提醒 → 立刻重算浇水
 *
 * 为什么必须重算浇水：pot_depth_mm / soil_id 是直接喂天气水分模型的，
 * 换完盆不重算，用户当天点进提醒详情看到的还是旧花盆算出来的数字。
 * 调 model 是当场读 plant 的字段，所以只是"消除窗口期"，不是"否则永远错"。
 */
router.post('/reminders/:id/repot', async (req, res, next) => {
  try {
    const db = getDb()
    const reminder = db
      .prepare('SELECT * FROM plant_reminders WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id)

    if (!reminder) {
      return res.status(404).json({ error: '提醒不存在', code: 'REMINDER_NOT_FOUND' })
    }

    if (reminder.type !== 'repot') {
      return res.status(400).json({ error: '这条提醒不是换盆提醒', code: 'NOT_REPOT_REMINDER' })
    }

    const plant = db.prepare('SELECT * FROM plants WHERE id = ?').get(reminder.plant_id)
    if (!plant) {
      return res.status(404).json({ error: '植物不存在', code: 'PLANT_NOT_FOUND' })
    }

    const body = req.body || {}
    const skipProfile = Boolean(body.skip_profile)
    const now = new Date().toISOString()

    // 1) 更新花盆 / 土壤（用户填了多少就更新多少）
    const profileFields = []
    const profileValues = []
    const PROFILE_KEYS = ['pot_size', 'pot_depth_mm', 'pot_diameter_mm', 'soil_type', 'soil_id', 'exposure']
    if (!skipProfile) {
      for (const key of PROFILE_KEYS) {
        if (body[key] !== undefined && body[key] !== '' && body[key] !== null) {
          profileFields.push(key + ' = ?')
          profileValues.push(body[key])
        }
      }
    }

    // 2) 换盆日 = 今天 → 缓苗期从今天起算（这是 transplanted_at 存在的意义）
    db.prepare(`
      UPDATE plants
      SET is_recent_transplant = 1, transplanted_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(now, plant.id)

    if (profileFields.length) {
      db.prepare(`UPDATE plants SET ${profileFields.join(', ')} WHERE id = ?`)
        .run(...profileValues, plant.id)
    }

    // 3) 完成这条换盆提醒（interval_days 为空，不会生成下一轮）
    const { completed } = finishReminder(db, reminder)

    const detail = skipProfile
      ? '换了盆，但没有更新花盆和土壤信息'
      : ['花盆：' + (body.pot_size || '未改'), '土壤：' + (body.soil_type || '未改')].join('｜')
    const journalResult = db
      .prepare('INSERT INTO plant_journal (plant_id, user_id, type, content) VALUES (?, ?, ?, ?)')
      .run(plant.id, reminder.user_id, 'repot', `完成提醒：换盆｜${detail}`)
    const journal = db.prepare('SELECT * FROM plant_journal WHERE id = ?').get(journalResult.lastInsertRowid)

    // 4) 花盆/土壤变了，立刻重算浇水（失败不拦，如实告诉用户）
    let waterWarning = ''
    const watering = db
      .prepare("SELECT * FROM plant_reminders WHERE plant_id = ? AND type = 'watering' AND status = 'pending' ORDER BY due_at LIMIT 1")
      .get(plant.id)
    if (watering) {
      try {
        await waterPlan.applyToReminder(watering.id)
      } catch (err) {
        waterWarning = err.message
      }
    }

    const fresh = db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(reminder.id)
    res.json({
      reminder: mapReminder(fresh),
      profile_updated: !skipProfile && profileFields.length > 0,
      transplant_until: transplantRest.restInfo(db.prepare('SELECT * FROM plants WHERE id = ?').get(plant.id)).untilText,
      water_warning: waterWarning,
      journal: {
        id: journal.id,
        type: journal.type,
        content: journal.content || '',
        created_at: journal.created_at
      },
      completed: Boolean(completed)
    })
  } catch (err) {
    next(err)
  }
})

router.post('/reminders/:id/treatment-feedback', (req, res) => {
  const db = getDb()
  const reminder = db
    .prepare('SELECT * FROM plant_reminders WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id)

  if (!reminder) {
    return res.status(404).json({
      error: '提醒不存在',
      code: 'REMINDER_NOT_FOUND'
    })
  }

  if (reminder.type !== 'treatment_feedback') {
    return res.status(400).json({
      error: '该提醒不是用药效果询问',
      code: 'NOT_TREATMENT_FEEDBACK'
    })
  }

  const round = Number(reminder.treatment_round || 1)
  const effective = Boolean(req.body && req.body.effective)
  const { completed } = finishReminder(db, reminder)
  const completedReminder = mapReminder(completed)

  // 反馈结果写进养护历程，方便回看整个用药过程
  db.prepare(`
    INSERT INTO plant_journal (plant_id, user_id, type, content)
    VALUES (?, ?, 'treatment_feedback', ?)
  `).run(
    reminder.plant_id,
    reminder.user_id,
    effective
      ? `第 ${round} 轮用药反馈：有效，病虫害已明显改善，本轮用药结束。`
      : `第 ${round} 轮用药反馈：无效，病虫害没有明显改善。`
  )

  if (effective) {
    return res.json({
      closed: true,
      need_ai_follow_up: false,
      round,
      reminder: completedReminder,
      next_treatment: null,
      next_feedback: null
    })
  }

  if (round >= 2) {
    return res.json({
      closed: false,
      need_ai_follow_up: true,
      round,
      reminder: completedReminder,
      next_treatment: null,
      next_feedback: null
    })
  }

  const nextRound = round + 1
  const { treatment, feedback } = createTreatmentPair(db, reminder, nextRound)

  res.json({
    closed: false,
    need_ai_follow_up: false,
    round,
    reminder: completedReminder,
    next_treatment: mapReminder(treatment),
    next_feedback: mapReminder(feedback)
  })
})

/**
 * 两个疗程都没有效果后，请 AI 判断是否需要换药、调整方案。
 * 这一步只生成建议，用户确认后才落库。
 */
router.post('/reminders/:id/treatment-consult', async (req, res, next) => {
  try {
    const db = getDb()
    const reminder = db
      .prepare('SELECT * FROM plant_reminders WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id)

    if (!reminder) {
      return res.status(404).json({
        error: '提醒不存在',
        code: 'REMINDER_NOT_FOUND'
      })
    }

    if (reminder.type !== 'treatment_feedback') {
      return res.status(400).json({
        error: '该提醒不是用药效果询问',
        code: 'NOT_TREATMENT_FEEDBACK'
      })
    }

    const plant = db.prepare('SELECT * FROM plants WHERE id = ?').get(reminder.plant_id)
    if (!plant) {
      return res.status(404).json({
        error: '植物不存在',
        code: 'PLANT_NOT_FOUND'
      })
    }

    const meta = parseMeta(reminder)
    const cycleId = meta.treatment_cycle_id || ''
    const disease = meta.disease || diseaseFromTitle(reminder.title)

    const linked = reminder.related_reminder_id
      ? db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(reminder.related_reminder_id)
      : null
    const rounds = collectCycleRounds(db, reminder.plant_id, cycleId)

    if (!rounds.length && linked) {
      rounds.push({
        round: Number(linked.treatment_round || 1),
        plan: linked.detail_content || linked.content || '',
        feedback: '没有明显改善'
      })
    }

    const suggestion = await aiAdapter.generateTreatmentAdjustment(plant, {
      disease,
      rounds
    })

    res.json({
      consult: {
        disease,
        round: Number(reminder.treatment_round || 1),
        previous_rounds: rounds.length,
        suggestion
      }
    })
  } catch (err) {
    next(err)
  }
})

/**
 * 用户在“两个疗程无效”后选择“暂不调整方案”。
 * 把这次拒绝真正落库：写入 meta_json 与养护历程，便于以后统计拒绝率、回看原因。
 */
router.post('/reminders/:id/treatment-consult/reject', (req, res, next) => {
  try {
    const db = getDb()
    const reminder = db
      .prepare('SELECT * FROM plant_reminders WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id)

    if (!reminder) {
      return res.status(404).json({
        error: '提醒不存在',
        code: 'REMINDER_NOT_FOUND'
      })
    }

    if (reminder.type !== 'treatment_feedback') {
      return res.status(400).json({
        error: '该提醒不是用药效果询问',
        code: 'NOT_TREATMENT_FEEDBACK'
      })
    }

    const reason = String((req.body && req.body.reason) || '').slice(0, 200)
    const now = new Date().toISOString()
    const meta = parseMeta(reminder)

    meta.adjustment_rejected_at = now
    if (reason) meta.adjustment_reject_reason = reason

    db.prepare(`
      UPDATE plant_reminders SET meta_json = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(meta), now, reminder.id)

    db.prepare(`
      INSERT INTO plant_journal (plant_id, user_id, type, content)
      VALUES (?, ?, 'treatment', ?)
    `).run(
      reminder.plant_id,
      reminder.user_id,
      '两个疗程没有明显改善，本次暂不采用 AI 调整方案' + (reason ? '：' + reason : '')
    )

    res.json({
      rejected: true,
      reminder_id: reminder.id,
      rejected_at: now
    })
  } catch (err) {
    next(err)
  }
})

// 用户确认采用调整方案后，创建新一轮用药提醒
router.post('/reminders/:id/treatment-consult/apply', (req, res) => {
  const db = getDb()
  const reminder = db
    .prepare('SELECT * FROM plant_reminders WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id)

  if (!reminder) {
    return res.status(404).json({
      error: '提醒不存在',
      code: 'REMINDER_NOT_FOUND'
    })
  }

  if (reminder.type !== 'treatment_feedback') {
    return res.status(400).json({
      error: '该提醒不是用药效果询问',
      code: 'NOT_TREATMENT_FEEDBACK'
    })
  }

  const plant = db.prepare('SELECT * FROM plants WHERE id = ?').get(reminder.plant_id)
  if (!plant) {
    return res.status(404).json({
      error: '植物不存在',
      code: 'PLANT_NOT_FOUND'
    })
  }

  const suggestion = req.body && req.body.suggestion
  if (!suggestion) {
    return res.status(400).json({
      error: '缺少调整方案内容',
      code: 'MISSING_SUGGESTION'
    })
  }

  const meta = parseMeta(reminder)
  const disease = meta.disease || diseaseFromTitle(reminder.title)
  const cycleId = `adjust_${Date.now()}`

  const { treatment, feedback } = createInitialTreatmentPair(db, plant, reminder.user_id, {
    cycleId,
    disease,
    treatmentTitle: `调整用药：${disease || '病虫害'}`,
    treatmentContent: suggestion,
    feedbackTitle: '用药效果询问（调整方案）',
    feedbackContent: '请确认调整方案用药后，病虫害是否有明显改善。'
  })

  db.prepare(`
    INSERT INTO plant_journal (plant_id, user_id, type, content)
    VALUES (?, ?, 'treatment', ?)
  `).run(
    plant.id,
    reminder.user_id,
    `两个疗程没有明显改善，已采用 AI 调整方案：${String(suggestion).slice(0, 120)}…`
  )

  res.status(201).json({
    applied: true,
    next_treatment: mapReminder(treatment),
    next_feedback: mapReminder(feedback)
  })
})

router.delete('/reminders/:id', (req, res) => {
  const db = getDb()
  const result = db
    .prepare('DELETE FROM plant_reminders WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.user.id)

  if (!result.changes) {
    return res.status(404).json({
      error: '提醒不存在',
      code: 'REMINDER_NOT_FOUND'
    })
  }

  res.status(204).end()
})

module.exports = router
