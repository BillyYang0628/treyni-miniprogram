const { buildReminderSummary } = require('./reminderText')
const knowledge = require('./knowledge')

function parseMeta(row) {
  if (!row || !row.meta_json) return {}
  try {
    return JSON.parse(row.meta_json) || {}
  } catch (e) {
    return {}
  }
}

/** 从标题里反推病害名，老数据没有 meta.disease 时使用 */
function diseaseFromTitle(title) {
  return String(title || '')
    .replace(/^喷药处理[:：]?/, '')
    .replace(/^复喷处理[:：]?/, '')
    .replace(/^换药方案[:：]?/, '')
    .replace(/（第 \d+ 轮）/, '')
    .trim()
}

function createTreatmentPair(db, reminder, round) {
  const now = Date.now()
  const sprayDueAt = new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString()
  const feedbackDueAt = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString()
  // 复喷属于同一个用药周期，必须沿用原周期 ID，否则回看历史时会把两轮拆开
  const cycleId = parseMeta(reminder).treatment_cycle_id || reminder.related_reminder_id || reminder.id
  const plant = db.prepare('SELECT name, species FROM plants WHERE id = ?').get(reminder.plant_id)
  const plantName = plant ? plant.name : ''
  const disease = parseMeta(reminder).disease || diseaseFromTitle(reminder.title)

  const sprayTitle = `复喷处理（第 ${round} 轮）`
  // 一个疗程无效后换用用药库里的方案 B（不同作用机理），而不是重复同一个方案
  const alternative = knowledge.getAlternativeScheme(disease, plant ? plant.species : '')
  const sprayContent = alternative
    ? `上一轮用药后没有明显改善，这一轮换用不同作用机理的药：${alternative.text}。切记同一类药连续用不超过 2 次，不要靠加大剂量硬扛。`
    : `根据上次用药反馈，执行第 ${round} 轮喷药，并继续观察叶片变化。`
  const feedbackTitle = `用药效果询问（第 ${round} 轮）`
  const feedbackContent = `请确认第 ${round} 轮用药后，病虫害是否有明显改善。`
  const sprayMeta = JSON.stringify({
    treatment_cycle_id: cycleId,
    treatment_round: round,
    disease
  })

  const sprayResult = db
    .prepare(`
      INSERT INTO plant_reminders (
        plant_id, user_id, type, title, content, summary_text, detail_content, due_at, interval_days,
        ai_model, status, treatment_round, meta_json
      ) VALUES (?, ?, 'treatment', ?, ?, ?, ?, ?, NULL, ?, 'pending', ?, ?)
    `)
    .run(
      reminder.plant_id,
      reminder.user_id,
      sprayTitle,
      sprayContent,
      buildReminderSummary({ type: 'treatment', title: sprayTitle }, plantName),
      sprayContent,
      sprayDueAt,
      alternative ? 'pesticide' : null,
      round,
      sprayMeta
    )

  const treatment = db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(sprayResult.lastInsertRowid)
  const feedbackMeta = JSON.stringify({
    treatment_cycle_id: cycleId,
    treatment_round: round,
    disease
  })

  const feedbackResult = db
    .prepare(`
      INSERT INTO plant_reminders (
        plant_id, user_id, type, title, content, summary_text, detail_content, due_at, interval_days,
        status, related_reminder_id, treatment_round, meta_json
      ) VALUES (?, ?, 'treatment_feedback', ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, ?)
    `)
    .run(
      reminder.plant_id,
      reminder.user_id,
      feedbackTitle,
      feedbackContent,
      buildReminderSummary({ type: 'treatment_feedback', title: feedbackTitle }, plantName),
      feedbackContent,
      feedbackDueAt,
      treatment.id,
      round,
      feedbackMeta
    )

  const feedback = db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(feedbackResult.lastInsertRowid)
  return { treatment, feedback }
}

function createInitialTreatmentPair(db, plant, userId, options = {}) {
  const now = Date.now()
  const sprayDueAt = new Date(now + 1 * 24 * 60 * 60 * 1000).toISOString()
  const feedbackDueAt = new Date(now + 4 * 24 * 60 * 60 * 1000).toISOString()
  const cycleId = options.cycleId || `diag_${Date.now()}`
  const round = 1
  const plantName = plant.name || ''
  const treatmentTitle = options.treatmentTitle || '按诊断结果喷药'
  const treatmentContent = options.treatmentContent || '根据 AI 诊断结果执行首次喷药处理，并观察叶片变化。'
  const feedbackTitle = options.feedbackTitle || '用药效果询问（第 1 轮）'
  const feedbackContent = options.feedbackContent || '请确认首次用药后，病虫害是否有明显改善。'
  const meta = JSON.stringify({
    treatment_cycle_id: cycleId,
    treatment_round: round,
    source: 'diagnosis',
    disease: options.disease || diseaseFromTitle(options.treatmentTitle)
  })

  const treatmentResult = db
    .prepare(`
      INSERT INTO plant_reminders (
        plant_id, user_id, type, title, content, summary_text, detail_content, due_at, interval_days,
        status, treatment_round, meta_json
      ) VALUES (?, ?, 'treatment', ?, ?, ?, ?, ?, NULL, 'pending', ?, ?)
    `)
    .run(
      plant.id,
      userId,
      treatmentTitle,
      treatmentContent,
      buildReminderSummary({ type: 'treatment', title: treatmentTitle }, plantName),
      treatmentContent,
      sprayDueAt,
      round,
      meta
    )

  const treatment = db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(treatmentResult.lastInsertRowid)
  const feedbackMeta = JSON.stringify({
    treatment_cycle_id: cycleId,
    treatment_round: round,
    source: 'diagnosis',
    disease: options.disease || diseaseFromTitle(options.treatmentTitle)
  })

  const feedbackResult = db
    .prepare(`
      INSERT INTO plant_reminders (
        plant_id, user_id, type, title, content, summary_text, detail_content, due_at, interval_days,
        status, related_reminder_id, treatment_round, meta_json
      ) VALUES (?, ?, 'treatment_feedback', ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, ?)
    `)
    .run(
      plant.id,
      userId,
      feedbackTitle,
      feedbackContent,
      buildReminderSummary({ type: 'treatment_feedback', title: feedbackTitle }, plantName),
      feedbackContent,
      feedbackDueAt,
      treatment.id,
      round,
      feedbackMeta
    )

  const feedback = db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(feedbackResult.lastInsertRowid)
  return { treatment, feedback }
}

/**
 * 取出一个用药周期内的所有轮次，用于“两个疗程都没效果”后的 AI 判断。
 */
function collectCycleRounds(db, plantId, cycleId) {
  const rows = db
    .prepare(`
      SELECT * FROM plant_reminders
      WHERE plant_id = ? AND type IN ('treatment', 'treatment_feedback')
      ORDER BY treatment_round ASC, id ASC
    `)
    .all(plantId)

  const treatmentByRound = new Map()
  const feedbackByRound = new Map()

  for (const row of rows) {
    const meta = parseMeta(row)
    if (cycleId && meta.treatment_cycle_id !== cycleId) continue

    const round = Number(row.treatment_round || 1)
    if (row.type === 'treatment') {
      treatmentByRound.set(round, row)
    } else {
      feedbackByRound.set(round, row)
    }
  }

  return Array.from(treatmentByRound.keys())
    .sort((a, b) => a - b)
    .map((round) => ({
      round,
      plan: (treatmentByRound.get(round) || {}).detail_content ||
        (treatmentByRound.get(round) || {}).content || '',
      feedback: feedbackByRound.has(round) ? '没有明显改善' : ''
    }))
}

module.exports = {
  createTreatmentPair,
  createInitialTreatmentPair,
  collectCycleRounds,
  parseMeta,
  diseaseFromTitle
}
