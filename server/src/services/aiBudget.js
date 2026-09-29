// AI 每日调用额度。
//
// 为什么要有：AI 是这套系统里唯一会「用量失控就烧钱」的部分。
// 5 个用户的正常用量约 30–50 元/月，但一次误操作（比如循环重排提醒）
// 或者有人把账号口令转出去，花费就没有上限了。
//
// 做法：按天计数，超过上限直接拒绝新调用。计数从 ai_metrics.jsonl 里恢复，
// 所以重启服务不会把当天已用的额度清零。
//
// 环境变量 AI_DAILY_CALL_LIMIT：每天的调用上限，0 表示不限（默认 400）。
const fs = require('node:fs')
const path = require('node:path')
const config = require('../config')

// 允许用 AI_METRICS_FILE 指到别处，回归脚本才好在临时文件上验证计数逻辑
const METRICS_FILE = process.env.AI_METRICS_FILE || path.resolve(config.rootDir, 'data/ai_metrics.jsonl')
const TZ_OFFSET_HOURS = 8 // 按北京时间切天，不用服务器时区

const limit = Number(process.env.AI_DAILY_CALL_LIMIT || 400)

let state = { dayStart: 0, used: 0 }

/** 北京时间当天 00:00 的时间戳 */
function dayStartOf(nowMs) {
  const shifted = new Date(nowMs + TZ_OFFSET_HOURS * 3600 * 1000)
  shifted.setUTCHours(0, 0, 0, 0)
  return shifted.getTime() - TZ_OFFSET_HOURS * 3600 * 1000
}

/** 从埋点里数今天已经用了多少次（正则解析，避免逐行 JSON.parse 的开销） */
function countToday(startMs) {
  try {
    const raw = fs.readFileSync(METRICS_FILE, 'utf8')
    let count = 0
    for (const line of raw.split('\n')) {
      if (!line) continue
      const matched = line.match(/"ts":"([^"]+)"/)
      if (!matched) continue
      if (Date.parse(matched[1]) >= startMs) count += 1
    }
    return count
  } catch (e) {
    return 0
  }
}

function currentState(nowMs = Date.now()) {
  const start = dayStartOf(nowMs)
  if (state.dayStart !== start) {
    state = { dayStart: start, used: countToday(start) }
  }
  return state
}

/** 还能不能调。limit<=0 表示不限量 */
function check(nowMs = Date.now()) {
  const snapshot = currentState(nowMs)
  if (limit <= 0) return { allowed: true, used: snapshot.used, limit }

  if (snapshot.used >= limit) {
    return {
      allowed: false,
      used: snapshot.used,
      limit,
      message: '今日 AI 额度已用完（已用 ' + snapshot.used + '/' + limit + ' 次），请明天再试。' +
        '如果确实需要提高上限，请管理员调整服务端的 AI_DAILY_CALL_LIMIT。'
    }
  }
  return { allowed: true, used: snapshot.used, limit }
}

/** 记一次调用（失败也记：失败同样可能产生费用，护栏要按"发出去的请求"算） */
function record(nowMs = Date.now()) {
  const snapshot = currentState(nowMs)
  snapshot.used += 1
  return snapshot.used
}

function status() {
  const snapshot = currentState()
  return { used: snapshot.used, limit, unlimited: limit <= 0 }
}

module.exports = { check, record, status }
