const aiAdapter = require('./aiAdapter')
const { getCareRule, getEnvironment } = require('./knowledge')
const reminderTiming = require('./reminderTiming')
const { buildRecentActivity } = require('./recentActivity')

// 只有这几类养护提醒需要 AI 安排下一轮
const CARE_TYPES = ['watering', 'fertilizing', 'pesticide', 'pruning']

function isCareType(type) {
  return CARE_TYPES.includes(type)
}

/**
 * 收集给 AI 的上下文：最近的日记、已完成的提醒、以及**上一轮实际做了什么**。
 *
 * 第 5 期加的是最后一项：以前这里只写"已完成：打药"，
 * AI 根本不知道用户实际用了什么药，只能照知识库重排。
 * 现在把完成登记里的「实际用了什么」一并喂过去，下一轮才排得准。
 *
 * 2026-09-21：这段实现挪到了 services/recentActivity.js —— AI 花农对话也要看同一份数据，
 * 两处各写一份必然出现"对话里说没记录、这里却按它排了"的矛盾。这里只做转发，口径不变。
 */
function buildHistory(db, plantId) {
  return buildRecentActivity(db, plantId).lines
}

function markPending(db, reminderId) {
  const now = new Date().toISOString()
  db.prepare(`
    UPDATE plant_reminders
    SET ai_status = 'pending', ai_error = NULL, updated_at = ?
    WHERE id = ?
  `).run(now, reminderId)
}

function markFailed(db, reminderId, message) {
  const now = new Date().toISOString()
  db.prepare(`
    UPDATE plant_reminders
    SET ai_status = 'failed', ai_error = ?, updated_at = ?
    WHERE id = ?
  `).run(String(message || 'AI 生成失败').slice(0, 300), now, reminderId)
}

/** 读取天气模型写进 meta 的浇水安排（存在说明这条是浇水提醒且已算过日期） */
function readWaterMeta(reminder) {
  if (!reminder || !reminder.meta_json) return null
  try {
    const meta = JSON.parse(reminder.meta_json) || {}
    return meta.water || null
  } catch (e) {
    return null
  }
}

/**
 * 为一条提醒生成 AI 建议（间隔 + 摘要 + 详细内容）。
 * 失败会抛错，由调用方决定如何暴露。
 */
async function generateAdvice(db, reminderId) {
  const reminder = db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(reminderId)

  if (!reminder) {
    const err = new Error('提醒不存在')
    err.code = 'REMINDER_NOT_FOUND'
    err.status = 404
    throw err
  }

  if (!isCareType(reminder.type)) {
    return { skipped: true, reason: '该提醒类型不需要 AI 安排下一轮' }
  }

  const plant = db.prepare('SELECT * FROM plants WHERE id = ?').get(reminder.plant_id)
  if (!plant) {
    const err = new Error('植物不存在')
    err.code = 'PLANT_NOT_FOUND'
    err.status = 404
    throw err
  }

  const knowledge = getCareRule(plant.species, reminder.type)
  const environment = getEnvironment(plant.species)
  const water = readWaterMeta(reminder)

  const advice = await aiAdapter.generateNextReminderAdvice(plant, {
    type: reminder.type,
    knowledge: knowledge
      ? {
          libraryLabel: knowledge.libraryLabel,
          interval_days: knowledge.interval_days,
          note: knowledge.note
        }
      : null,
    environment,
    history: buildHistory(db, reminder.plant_id),
    // 浇水：日期已由天气模型算好，AI 只写文案，不改间隔
    water: reminder.type === 'watering' ? water : null
  })

  const now = new Date().toISOString()
  // 方案级候选 + 实时问题一起存下来，完成面板直接用
  const optionsJson = JSON.stringify({ options: advice.options || [], ask: advice.ask || '' })

  if (water) {
    // 日期与间隔保持天气模型的结果，只更新文案
    db.prepare(`
      UPDATE plant_reminders
      SET summary_text = ?, detail_content = ?,
          ai_model = 'water_model+ai', ai_generated_at = ?, ai_status = 'done',
          ai_error = NULL, ai_reason = ?, options_json = ?, updated_at = ?
      WHERE id = ?
    `).run(advice.summary, advice.detail, now, advice.reason, optionsJson, now, reminder.id)
  } else {
    const dueAt = new Date(Date.now() + advice.interval_days * 24 * 60 * 60 * 1000).toISOString()
    db.prepare(`
      UPDATE plant_reminders
      SET interval_days = ?, due_at = ?, summary_text = ?, detail_content = ?,
          ai_model = 'ai', ai_generated_at = ?, ai_status = 'done',
          ai_error = NULL, ai_reason = ?, options_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      advice.interval_days,
      dueAt,
      advice.summary,
      advice.detail,
      now,
      advice.reason,
      optionsJson,
      now,
      reminder.id
    )
  }

  // 间隔被 AI 重排过，阈值要按新的间隔重新冻结
  reminderTiming.freezeTiming(db, reminder.id)

  return { updated: true, advice, waterModel: Boolean(water) }
}

/**
 * 后台执行：不阻塞用户操作，失败会把状态写成 failed 供前端重试。
 */
function scheduleAdviceInBackground(db, reminderId) {
  markPending(db, reminderId)

  generateAdvice(db, reminderId).catch((err) => {
    console.warn('[nextReminder] 提醒 #' + reminderId + ' 的 AI 建议生成失败：' + err.message)
    try {
      markFailed(db, reminderId, err.message)
    } catch (e) {
      console.warn('[nextReminder] 写入失败状态时出错：' + e.message)
    }
  })
}

module.exports = {
  CARE_TYPES,
  isCareType,
  readWaterMeta,
  buildHistory,
  markPending,
  markFailed,
  generateAdvice,
  scheduleAdviceInBackground
}
