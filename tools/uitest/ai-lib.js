/**
 * 「提示词块」验证脚本的公共部分。
 *
 * 和 lib.js 的区别：lib.js 走 HTTP 打后端；这里直接 require 服务端 service，
 * 因为提示词块要验证的是**模型输出**，不需要经过接口。
 * 好处是不用起后端、不用造临时植物、失败信息也更直接。
 *
 * 注意：工具的脚本默认不带 --env-file，而 AI 调用要 key，所以自己加载一次 server/.env。
 */
const path = require('node:path')

const SERVER_DIR = path.resolve(__dirname, '../../server')

function loadEnv() {
  if (process.env.AI_API_KEY) return
  try {
    process.loadEnvFile(path.join(SERVER_DIR, '.env'))
  } catch (err) {
    console.error('读不到 server/.env（AI 调用需要 key）：' + err.message)
    process.exit(2)
  }
}

const state = { pass: 0, fail: 0 }

function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (ok) state.pass++
  else state.fail++
  return ok
}

function checkTruthy(label, actual, extra) {
  const ok = Boolean(actual)
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | ' + (ok ? '命中' : '没命中') +
    (extra ? ' | ' + extra : ''))
  if (ok) state.pass++
  else state.fail++
  return ok
}

function fail(label, detail) {
  console.log('FAIL | ' + label + ' | ' + detail)
  state.fail++
}

/** 中文字数：不含空白（换行、空格都不算，和字数上限的口径一致） */
function countChars(text) {
  return String(text || '').replace(/\s/g, '').length
}

/** 按句号/问号/感叹号/换行切句，返回非空句子 */
function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[。！？!?])|\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/** 数出 ①②③ 这类编号用到了第几个（没用编号返回 0） */
function maxCircledNumber(text) {
  const marks = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩']
  let max = 0
  marks.forEach((mark, index) => {
    if (String(text || '').includes(mark)) max = Math.max(max, index + 1)
  })
  return max
}

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

function summary() {
  console.log('')
  console.log(state.fail === 0 ? '全部通过' : state.fail + ' 项未通过')
  return state.fail
}

module.exports = {
  SERVER_DIR,
  loadEnv,
  check,
  checkTruthy,
  fail,
  countChars,
  splitSentences,
  maxCircledNumber,
  median,
  summary
}
