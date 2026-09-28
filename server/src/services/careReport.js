/**
 * 一键生成植物养护报告
 * 聚合：植物档案、养护日记、提醒完成情况、AI 诊断与用药记录、对话摘要、当前水分状态
 * 生成：交给 Moonshot 写成面向中小学生的报告（分章节）
 * 输出：结构化 JSON（章节、亮点、下一步建议）+ 统计数字，后续接 PDF/图片导出
 */
const { getDb } = require('../db')
const aiAdapter = require('./aiAdapter')
const knowledge = require('./knowledge')
const waterPlan = require('./waterPlan')

const TYPE_LABEL = {
  watering: '浇水',
  fertilizing: '施肥',
  pesticide: '打药',
  pruning: '修剪',
  treatment: '喷药处理',
  treatment_feedback: '用药反馈',
  diagnosis: 'AI 诊断',
  custom: '其他记录'
}

function daysBetween(from, to) {
  const start = new Date(from)
  const end = new Date(to)
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null
  return Math.max(0, Math.round((end - start) / 86400000))
}

function formatDate(value) {
  if (!value) return ''
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  const ymd = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

  // 直接传 Date（例如报告截止日 new Date()）时按本地日期格式化，
  // 不能走下面的字符串分支，否则会被当成 "Mon Sep 14 ..." 解析失败。
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? '' : ymd(value)
  }

  const text = String(value)
  const date = new Date(text.replace(' ', 'T') + (text.includes('T') ? '' : 'Z'))
  if (isNaN(date.getTime())) return text.slice(0, 10)
  return ymd(date)
}

/** 汇总一盆植物从种下到现在的全部养护数据 */
function collectReportData(plantId, userId) {
  const db = getDb()
  const plant = db.prepare('SELECT * FROM plants WHERE id = ? AND user_id = ?').get(plantId, userId)
  if (!plant) return null

  const journals = db
    .prepare('SELECT * FROM plant_journal WHERE plant_id = ? ORDER BY created_at ASC, id ASC')
    .all(plantId)

  const reminders = db
    .prepare('SELECT * FROM plant_reminders WHERE plant_id = ? ORDER BY created_at ASC, id ASC')
    .all(plantId)

  const waterEvents = db
    .prepare('SELECT * FROM plant_water_events WHERE plant_id = ? ORDER BY happened_at DESC LIMIT 20')
    .all(plantId)

  const session = db
    .prepare('SELECT * FROM chat_sessions WHERE plant_id = ? AND user_id = ?')
    .get(plantId, userId)

  // 按类型统计日记
  const journalByType = {}
  for (const item of journals) {
    journalByType[item.type] = (journalByType[item.type] || 0) + 1
  }

  const completed = reminders.filter((item) => item.status === 'completed')
  const pending = reminders.filter((item) => item.status === 'pending')

  // 按期完成率：完成时间不晚于到期日
  const onTime = completed.filter((item) => item.completed_at && item.due_at && item.completed_at <= item.due_at)

  const diagnoses = journals.filter((item) => item.type === 'diagnosis')
  const treatments = reminders.filter((item) => item.type === 'treatment')
  const feedbacks = reminders.filter((item) => item.type === 'treatment_feedback')

  const firstJournal = journals[0]
  const lastJournal = journals[journals.length - 1]
  // 开始养护日期是选填的（网购/花市买回来常常不知道），没填就按"加入档案那天"起算
  const careStart = plant.planting_date || plant.created_at
  const careDays = careStart ? daysBetween(careStart, new Date()) : null

  const knowledgeRule = knowledge.getCareRule(plant.species, 'watering')
  const waterState = reminders
    .filter((item) => item.type === 'watering' && item.status === 'pending')
    .map((item) => {
      let meta = {}
      try {
        meta = item.meta_json ? JSON.parse(item.meta_json) : {}
      } catch (e) {
        meta = {}
      }
      return meta.water || null
    })
    .find(Boolean)

  return {
    plant: {
      id: plant.id,
      name: plant.name,
      species: plant.species,
      variety: plant.variety || '',
      pot_size: plant.pot_size || '',
      soil: plant.soil_type || '',
      exposure: waterPlan.getUserLocation(userId) ? plant.exposure || '' : plant.exposure || '',
      location: plant.location || '',
      light: plant.light_environment || '',
      planting_date: plant.planting_date || '',
      created_at: plant.created_at || '',
      growth_stage: plant.growth_stage || '',
      source: plant.plant_source || '',
      notes: plant.notes || ''
    },
    stats: {
      care_days: careDays,
      journal_total: journals.length,
      journal_by_type: journalByType,
      reminder_total: reminders.length,
      reminder_completed: completed.length,
      reminder_pending: pending.length,
      on_time_rate: completed.length ? Math.round((onTime.length / completed.length) * 100) : null,
      diagnosis_count: diagnoses.length,
      treatment_count: treatments.length,
      feedback_count: feedbacks.length,
      water_event_count: waterEvents.length,
      first_record_at: firstJournal ? firstJournal.created_at : '',
      last_record_at: lastJournal ? lastJournal.created_at : ''
    },
    waterState,
    knowledge: knowledgeRule
      ? { interval_days: knowledgeRule.interval_days, note: knowledgeRule.note, library: knowledgeRule.libraryLabel }
      : null,
    timeline: journals.slice(-30).map((item) => ({
      type: TYPE_LABEL[item.type] || item.type,
      content: String(item.content || '').replace(/\s+/g, ' ').slice(0, 120),
      date: formatDate(item.created_at)
    })),
    diagnoses: diagnoses.slice(-5).map((item) => ({
      date: formatDate(item.created_at),
      content: String(item.content || '').replace(/\s+/g, ' ').slice(0, 200)
    })),
    chatSummary: session ? session.summary || '' : ''
  }
}

function buildPrompt(data) {
  const { plant, stats, waterState, knowledge: rule } = data

  const profileLines = [
    `植物：${plant.name}（${plant.species}${plant.variety ? ' · ' + plant.variety : ''}）`,
    `苗情：${plant.growth_stage || '未填写'}｜来源：${plant.source || '未填写'}`,
    `开始养护日期：${plant.planting_date || '未填写（按加入档案那天起算）'}` +
      '（这是用户到手/开始养它的日期，不是播种日期，不要据此推算苗龄）',
    `花盆：${plant.pot_size || '未填写'}｜基质：${plant.soil || '未填写'}`,
    `位置：${plant.location || '未填写'}｜环境：${plant.exposure || '未填写'}｜光照：${plant.light || '未填写'}`
  ]

  const statsLines = [
    `养护天数：${stats.care_days === null ? '未知' : stats.care_days + ' 天'}`,
    `养护日记：${stats.journal_total} 条（` +
      Object.entries(stats.journal_by_type).map(([type, count]) => `${TYPE_LABEL[type] || type} ${count} 条`).join('、') + '）',
    `提醒：共 ${stats.reminder_total} 条，已完成 ${stats.reminder_completed} 条，待办 ${stats.reminder_pending} 条` +
      (stats.on_time_rate === null ? '' : `，按期完成率 ${stats.on_time_rate}%`),
    `AI 诊断：${stats.diagnosis_count} 次｜用药处理：${stats.treatment_count} 次｜用药反馈：${stats.feedback_count} 条`
  ]

  if (rule) {
    statsLines.push(`知识库标准节奏：每 ${rule.interval_days} 天浇一次（${rule.library}）`)
  }

  if (waterState) {
    statsLines.push(
      `当前水分账户：剩余约 ${waterState.tank_percent}%，预估下次浇水 ${waterState.next_due_date}` +
      (waterState.city ? `，已结合 ${waterState.city} 天气` : '')
    )
  }

  const timelineLines = data.timeline.map((item) => `${item.date}【${item.type}】${item.content}`)
  const diagnosisLines = data.diagnoses.map((item) => `${item.date}：${item.content}`)

  return [
    '【植物档案】',
    ...profileLines,
    '',
    '【养护统计】',
    ...statsLines,
    '',
    '【养护历程（节选）】',
    ...(timelineLines.length ? timelineLines : ['（这段时间还没有记录）']),
    '',
    '【AI 诊断记录】',
    ...(diagnosisLines.length ? diagnosisLines : ['（没有诊断记录）']),
    '',
    data.chatSummary ? '【与托蕾妮的对话摘要】\n' + data.chatSummary : ''
  ].filter(Boolean).join('\n')
}

/** 调用 AI 生成报告正文 */
async function generateContent(data) {
  const messages = [
    {
      role: 'system',
      content: [
        '你是一名家庭园艺老师，正在为学生写一份这盆植物的养护报告。',
        '只根据下面提供的真实记录来写，不要编造没有发生过的养护动作或数据。',
        '如果某些信息缺失（例如没填光照），可以指出“档案里还没记录”，但不要凭空假设具体数值。',
        '语气亲切、口语化，像老师当面点评，符合中小学生的阅读水平。',
        '只输出一个 JSON，不要输出其他文字，格式：',
        '{"title":"报告标题","summary":"2-3 句整体评价","sections":[{"heading":"小节标题","body":"正文"}],"highlights":["做得好的地方，2-4 条"],"next_actions":["接下来要做的，2-4 条，要具体可执行"]}',
        '要求：',
        '1. sections 写 4 个小节：这段时间养得怎么样 / 做过哪些养护 / 遇到的问题和处理 / 接下来怎么养。',
        '2. 每个小节 100-200 字，用数字说话（浇了多少次、按期完成率多少等）。',
        '3. highlights 与 next_actions 各 2-4 条，每条不超过 30 字。',
        '4. 涉及药剂、浓度、间隔时，与提供的知识库和记录保持一致，不要自创数值。',
        '5. 不用 markdown 符号，不要空话和鼓励喊口号。'
      ].join('\n')
    },
    { role: 'user', content: buildPrompt(data) }
  ]

  const content = await aiAdapter.chat(null, messages, 'careReport', { json: true })
  const parsed = aiAdapter.parseJsonContent(content)

  const title = String(parsed.title || '').trim()
  const summary = String(parsed.summary || '').trim()
  const sections = Array.isArray(parsed.sections)
    ? parsed.sections
        .filter((item) => item && (item.heading || item.body))
        .map((item) => ({ heading: String(item.heading || '').trim(), body: String(item.body || '').trim() }))
    : []

  if (!summary && !sections.length) {
    const err = new Error('AI 没有返回有效的报告内容')
    err.code = 'REPORT_EMPTY'
    err.status = 502
    err.detail = String(content).slice(0, 200)
    throw err
  }

  return {
    title: title || `${data.plant.name} · 养护报告`,
    summary,
    sections,
    highlights: Array.isArray(parsed.highlights) ? parsed.highlights.map((t) => String(t).trim()).filter(Boolean) : [],
    next_actions: Array.isArray(parsed.next_actions) ? parsed.next_actions.map((t) => String(t).trim()).filter(Boolean) : []
  }
}

function periodText(data) {
  // 报告覆盖“从开始养护到现在”：优先用用户填的开始养护日期，
  // 没填就用加入档案那天，再退回第一条记录
  const start = data.plant.planting_date
    ? formatDate(data.plant.planting_date)
    : (data.plant.created_at
      ? formatDate(data.plant.created_at)
      : (data.stats.first_record_at ? formatDate(data.stats.first_record_at) : ''))
  const end = formatDate(new Date())
  if (!start) return end
  return `${start} 至 ${end}`
}

/** 创建生成请求（异步执行，失败显式记录） */
function createRequest(plantId, userId, params = {}) {
  const db = getDb()
  const plant = db.prepare('SELECT * FROM plants WHERE id = ? AND user_id = ?').get(plantId, userId)
  if (!plant) return null

  const result = db
    .prepare(`
      INSERT INTO report_requests (plant_id, user_id, report_type, params_json, status)
      VALUES (?, ?, 'care_summary', ?, 'generating')
    `)
    .run(plantId, userId, JSON.stringify(params))

  return { id: Number(result.lastInsertRowid), plant }
}

function markRequest(db, requestId, status, errorInfo) {
  db.prepare(`
    UPDATE report_requests SET status = ?, error_info = ?, updated_at = datetime('now') WHERE id = ?
  `).run(status, errorInfo ? String(errorInfo).slice(0, 500) : null, requestId)
}

/** 后台生成报告 */
async function runGeneration(requestId) {
  const db = getDb()
  const request = db.prepare('SELECT * FROM report_requests WHERE id = ?').get(requestId)
  if (!request) return

  try {
    const data = collectReportData(request.plant_id, request.user_id)
    if (!data) throw new Error('植物不存在或不属于当前用户')

    const content = await generateContent(data)
    const period = periodText(data)

    const inserted = db.prepare(`
      INSERT INTO reports (request_id, plant_id, user_id, title, period_text, content_json, stats_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      requestId,
      request.plant_id,
      request.user_id,
      content.title,
      period,
      JSON.stringify(content),
      JSON.stringify(data.stats)
    )

    markRequest(db, requestId, 'completed', null)
    return { id: Number(inserted.lastInsertRowid), content, period }
  } catch (err) {
    console.warn('[careReport] 报告生成失败：' + err.message)
    markRequest(db, requestId, 'failed', err.message)
    throw err
  }
}

function scheduleGeneration(requestId) {
  runGeneration(requestId).catch(() => {})
}

function mapReport(row) {
  if (!row) return null
  let content = null
  let stats = null
  try {
    content = row.content_json ? JSON.parse(row.content_json) : null
  } catch (e) {
    content = null
  }
  try {
    stats = row.stats_json ? JSON.parse(row.stats_json) : null
  } catch (e) {
    stats = null
  }

  return {
    id: row.id,
    plant_id: row.plant_id,
    title: row.title,
    period_text: row.period_text,
    content,
    stats,
    file_url: row.file_url || '',
    generated_at: row.generated_at
  }
}

function mapRequest(row) {
  if (!row) return null
  return {
    id: row.id,
    plant_id: row.plant_id,
    status: row.status,
    error_info: row.error_info || '',
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

module.exports = {
  TYPE_LABEL,
  periodText,
  formatDate,
  collectReportData,
  createRequest,
  scheduleGeneration,
  runGeneration,
  mapReport,
  mapRequest
}
