/**
 * 提醒的「提前 / 逾期」判定。
 *
 * 规则来自《每日提醒阈值方案.md》（2026-09-18 定稿）：
 *
 *   提前容忍 T = clamp( round(周期 × 系数), 下限, 上限 )
 *     浇水 固定 1 天（不参与缩放）
 *     施肥 25%，夹在 [2, 5]
 *     打药 20%，夹在 [2, 3]（打药靠间隔本身起效，收得最紧）
 *     修剪 25%，夹在 [3, 10]
 *     诊断生成的疗程用药（meta.treatment_cycle_id）强制 1 天——疗程不能乱
 *   逾期容忍 = clamp( round(周期 × 25%), 1, 7 )
 *
 * 舍入统一用 Math.round（0.5 向上）。文档里"施肥 10 天 → 2"那一格是笔误，
 * 按公式应为 3（10 × 0.25 = 2.5 → Math.round(2.5) = 3），代码以公式为准。
 *
 * T 会**冻结在提醒上**（meta.timing）：点完成时只读不算。
 * 否则 interval_days 被 AI 每次调整，同一条提醒的阈值会跟着抖，也没法写回归测试。
 */
const { daysUntilDue } = require('./reminderText')

const RULES = {
  watering: { mode: 'fixed', tolerance: 1 },
  fertilizing: { mode: 'scaled', ratio: 0.25, min: 2, max: 5 },
  pesticide: { mode: 'scaled', ratio: 0.2, min: 2, max: 3 },
  pruning: { mode: 'scaled', ratio: 0.25, min: 3, max: 10 }
}

const LATE_RATIO = 0.25
const LATE_MIN = 1
const LATE_MAX = 7

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function parseMeta(metaJson) {
  try {
    return metaJson ? JSON.parse(metaJson) : {}
  } catch (e) {
    return {}
  }
}

/**
 * 提前容忍天数。
 * @returns {number|null} null 表示这类提醒不做"太早"判定
 */
function toleranceDays(type, intervalDays, meta) {
  if (meta && meta.treatment_cycle_id) return 1
  // 缓苗期的施肥提醒正文写的是"先不施肥"，根本没有"提前做"的概念
  if (meta && meta.rest === 'transplant') return null

  const rule = RULES[type]
  if (!rule) return null // custom 等没有知识库周期的类型
  if (rule.mode === 'fixed') return rule.tolerance

  const interval = Number(intervalDays)
  if (!Number.isFinite(interval) || interval <= 0) return null
  return clamp(Math.round(interval * rule.ratio), rule.min, rule.max)
}

/** 逾期容忍天数（超过才需要问原因） */
function lateToleranceDays(intervalDays) {
  const interval = Number(intervalDays)
  if (!Number.isFinite(interval) || interval <= 0) return LATE_MAX
  return clamp(Math.round(interval * LATE_RATIO), LATE_MIN, LATE_MAX)
}

/** 算一份 timing（冻结用） */
function computeTiming(reminder) {
  const meta = parseMeta(reminder && reminder.meta_json)
  const interval = Number(reminder && reminder.interval_days) || null

  return {
    tolerance_days: toleranceDays(reminder && reminder.type, interval, meta),
    late_tolerance_days: lateToleranceDays(interval),
    interval_days: interval,
    rule: meta.treatment_cycle_id
      ? 'treatment-cycle'
      : (RULES[reminder && reminder.type] ? 'type-scaled' : 'none'),
    computed_at: new Date().toISOString()
  }
}

/** 读冻结的 timing；没有就现算一份（懒回填由调用方决定要不要落库） */
function readTiming(reminder) {
  const meta = parseMeta(reminder && reminder.meta_json)
  const timing = meta.timing
  if (timing && typeof timing.tolerance_days !== 'undefined') return timing
  return null
}

/**
 * 判定这条提醒现在处于哪一档。
 * @returns {{level:string, early_days:number, late_days:number, tolerance_days:number|null,
 *            late_tolerance_days:number, interval_days:number|null, frozen:boolean}}
 */
function evaluate(reminder, now = new Date()) {
  const timing = readTiming(reminder) || computeTiming(reminder)
  const diff = daysUntilDue(reminder && reminder.due_at, now)

  const earlyDays = diff !== null && diff > 0 ? diff : 0
  const lateDays = diff !== null && diff < 0 ? -diff : 0
  const tolerance = typeof timing.tolerance_days === 'number' ? timing.tolerance_days : null

  let level = 'ok'
  if (tolerance !== null && earlyDays > tolerance) level = 'too_early'
  else if (earlyDays > 0) level = 'early'
  else if (lateDays > (timing.late_tolerance_days || LATE_MAX)) level = 'too_late'
  else if (lateDays > 0) level = 'late'

  return {
    level,
    early_days: earlyDays,
    late_days: lateDays,
    tolerance_days: tolerance,
    late_tolerance_days: timing.late_tolerance_days,
    interval_days: timing.interval_days,
    frozen: Boolean(readTiming(reminder))
  }
}

/**
 * 把 timing 冻结到提醒上。
 * 调用的地方＝"这条提醒的方案真正变了"的地方（新建、AI 重排、天气模型重算、手动改期）。
 */
function freezeTiming(db, reminderId) {
  const row = db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(reminderId)
  if (!row) return null

  const meta = parseMeta(row.meta_json)
  meta.timing = computeTiming(row)

  db.prepare('UPDATE plant_reminders SET meta_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(meta),
    new Date().toISOString(),
    reminderId
  )
  return meta.timing
}

/** 读不到就现算并落库（懒回填，覆盖老数据） */
function ensureTiming(db, reminderId) {
  const row = db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(reminderId)
  if (!row) return null
  const existing = readTiming(row)
  if (existing) return existing
  return freezeTiming(db, reminderId)
}

module.exports = {
  RULES,
  LATE_MAX,
  toleranceDays,
  lateToleranceDays,
  computeTiming,
  readTiming,
  evaluate,
  freezeTiming,
  ensureTiming
}
