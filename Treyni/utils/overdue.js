/**
 * 逾期配色。
 *
 * 需求（2026-09-18）：逾期的提醒在列表里要一眼看得出来，
 * 且时间越久越往明红过渡、7 天封顶——挂了再久也不该比"挂了 7 天"看起来更吓人。
 *
 * 用固定 8 档色表而不是实时插值：像素风的界面里固定色阶更好控制，
 * 也让回归测试能写死断言（天数到颜色一一对应）。
 *
 * 第 0 档就是提醒原本的边框色，所以没逾期的提醒看起来和以前完全一样。
 */
const OVERDUE_COLORS = [
  '#2d3a2d', // 0 天：今天到期，就是原来的近黑
  '#4a4030', // 1 天
  '#5f4530', // 2 天
  '#754a30', // 3 天
  '#8c4d30', // 4 天
  '#a84d33', // 5 天
  '#c04a3a', // 6 天
  '#e5484d'  // 7 天及以上：封顶，不再变深
]

const MAX_STEP = OVERDUE_COLORS.length - 1

/** 逾期天数 → 边框色 */
function overdueColor(lateDays) {
  const days = Math.max(0, Math.floor(Number(lateDays) || 0))
  return OVERDUE_COLORS[Math.min(days, MAX_STEP)]
}

/** 是否已经逾期（0 天算没逾期） */
function isOverdue(lateDays) {
  return (Number(lateDays) || 0) > 0
}

module.exports = {
  OVERDUE_COLORS,
  overdueColor,
  isOverdue
}
