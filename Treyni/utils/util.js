const formatTime = date => {
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hour = date.getHours()
  const minute = date.getMinutes()
  const second = date.getSeconds()

  return `${[year, month, day].map(formatNumber).join('/')} ${[hour, minute, second].map(formatNumber).join(':')}`
}

const formatNumber = n => {
  n = n.toString()
  return n[1] ? n : `0${n}`
}

/** 兼容 iOS 的日期解析：SQLite 返回的 "YYYY-MM-DD HH:mm:ss" 默认按 UTC 处理 */
const parseDate = value => {
  if (!value) return null
  if (value instanceof Date) return value

  const text = String(value).trim()
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? text.replace(' ', 'T') + 'Z'
    : text

  const date = new Date(normalized)
  return isNaN(date.getTime()) ? null : date
}

/** 9月11日 14:03 */
const formatDateTime = value => {
  const date = parseDate(value)
  if (!date) return ''
  return `${date.getMonth() + 1}月${date.getDate()}日 ${formatNumber(date.getHours())}:${formatNumber(date.getMinutes())}`
}

/** 9月11日 */
const formatDay = value => {
  const date = parseDate(value)
  if (!date) return ''
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

// 这里只放纯文字。图标一律走 utils/icons.js 的 TYPE_ICONS，
// 由页面渲染成 <image>，不要在这里再拼 emoji。
const REMINDER_TYPE_TEXT = {
  watering: '浇水',
  fertilizing: '施肥',
  pesticide: '打药',
  pruning: '修剪',
  repot: '换盆',
  treatment: '喷药',
  treatment_feedback: '用药效果反馈',
  custom: '养护提醒'
}

const JOURNAL_TYPE_TEXT = {
  watering: '浇水',
  fertilizing: '施肥',
  pesticide: '打药',
  pruning: '修剪',
  repot: '换盆',
  treatment: '喷药',
  treatment_feedback: '用药反馈',
  diagnosis: 'AI 诊断',
  custom: '记录'
}

module.exports = {
  formatTime,
  parseDate,
  formatDateTime,
  formatDay,
  REMINDER_TYPE_TEXT,
  JOURNAL_TYPE_TEXT
}
