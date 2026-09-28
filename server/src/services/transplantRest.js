/**
 * 缓苗期判定（单一来源，供默认提醒、AI 对话、提醒方案、养护报告共用）。
 *
 * 背景：网购或花市买回来的花大多是现成的小苗/中苗，用户并不知道真正的"种下日期"，
 * 档案里的日期实际是"开始养护的日期"。所以缓苗期不能按那个日期推算，
 * 而应该按"用户把植物加进来的时间"（也就是"刚换盆/刚移栽"这件事发生的时刻）起算。
 */
const REST_DAYS = 14

function parseCreatedAt(value) {
  if (!value) return null
  if (value instanceof Date) return value
  const text = String(value)
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? text.replace(' ', 'T') + 'Z'
    : text
  const date = new Date(iso)
  return isNaN(date.getTime()) ? null : date
}

/** 返回 { active, until, daysLeft, untilText } */
function restInfo(plant, now = new Date()) {
  if (!plant || !Number(plant.is_recent_transplant)) {
    return { active: false, until: null, daysLeft: 0, untilText: '' }
  }

  // 起算点优先用"实际换盆/移栽那天"。
  // 老数据没有这个字段，就退回 created_at（原行为），
  // 对"添加植物时勾了刚换盆"这种情况仍然正确。
  const start = parseCreatedAt(plant.transplanted_at) || parseCreatedAt(plant.created_at) || now
  const until = new Date(start.getTime() + REST_DAYS * 86400000)
  const daysLeft = Math.max(0, Math.ceil((until - now) / 86400000))

  return {
    active: until > now,
    until,
    daysLeft,
    untilText: (until.getMonth() + 1) + ' 月 ' + until.getDate() + ' 日'
  }
}

/** 本地日期字符串（YYYY-MM-DD），用于和用户看到的"X 月 X 日"保持一致 */
function localDateString(date) {
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

module.exports = { REST_DAYS, restInfo, parseCreatedAt, localDateString }
