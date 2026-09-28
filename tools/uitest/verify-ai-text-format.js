/**
 * A-2 的 AI 层验证：模型真的按「分段」要求输出了吗？
 *
 * 和 verify-ai-text.js 的分工：
 *   verify-ai-text.js        纯函数，验**渲染组件**怎么切段、怎么高亮；
 *   verify-ai-text-format.js 真调模型，验**提示词**有没有让模型做到分段（本文件）。
 *
 * 对 6 个面向用户的 AI 场景各跑一次，断言：
 *   ① 不存在「同一段里塞了 3 个以上 ①②③ 编号」（批注 2 说的就是这个）
 *   ② 段落数不少于 3（病害介绍不少于 4：是什么 / 长什么样 / 什么条件 / 怎么预防）
 *   ③ 最长一段不超过 200 字
 *
 * **这个脚本只在开发机上手动跑，不进小程序、也不在任何用户请求路径上**，
 * 所以不会拖慢用户实际使用时的 AI 生成速度（跑一次约 2-3 分钟，6 次调用）。
 *
 * 用法：node verify-ai-text-format.js
 */
const path = require('node:path')
const { SERVER_DIR, loadEnv, check, checkTruthy, fail, summary } = require('./ai-lib')

loadEnv()
const aiAdapter = require(path.join(SERVER_DIR, 'src/services/aiAdapter.js'))

const PLANT = {
  name: '阳台那盆月季',
  species: '月季',
  variety: '微型月季',
  pot_size: '15 厘米口径',
  soil_type: '通用营养土',
  location: '南阳台',
  light_environment: '每天大约 5 小时直射光'
}

const CHAT_CONTEXT = {
  profile: { variety: '微型月季', pot_size: '15 厘米口径', location: '南阳台' },
  reminders: [{ title: '给月季浇水', type: 'watering', interval_days: 3, due_at: '2026-09-24' }],
  careRules: []
}

const CIRCLED = /[①②③④⑤⑥⑦⑧⑨⑩]/g

function paragraphs(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function charsOf(text) {
  return String(text || '').replace(/\s/g, '').length
}

function maxCircledInOneParagraph(text) {
  return paragraphs(text).reduce((max, part) => {
    const count = (part.match(CIRCLED) || []).length
    return Math.max(max, count)
  }, 0)
}

function longestParagraph(text) {
  return paragraphs(text).reduce((max, part) => Math.max(max, charsOf(part)), 0)
}

/** 每个场景统一跑同一套断言 */
function audit(label, text, options = {}) {
  const body = String(text || '')
  const parts = paragraphs(body)
  const minParagraphs = options.minParagraphs || 3
  const longest = longestParagraph(body)
  const maxCircled = maxCircledInOneParagraph(body)

  console.log('--- ' + label + '（' + charsOf(body) + ' 字，' + parts.length + ' 段，最长段 ' +
    longest + ' 字，单段最多 ' + maxCircled + ' 个编号）---')

  checkTruthy('[' + label + '] 有内容', body.length > 0)
  check('[' + label + '] 没有"一段里 3 个以上编号"', maxCircled <= 2, true)
  check('[' + label + '] 段落数 ≥ ' + minParagraphs, parts.length >= minParagraphs, true)
  check('[' + label + '] 最长段 ≤ 200 字', longest <= 200, true)
}

async function main() {
  console.log('=== ① 用药指导 / ② 病害介绍（diagnosis.*）===')
  const report = await aiAdapter.generateDiagnosisReport(PLANT, {
    disease: '黑斑病',
    severity: 'mild',
    evidence: '叶片上出现黑色圆斑，边缘有黄晕'
  })
  audit('diagnosis.treatment', report.treatment)
  audit('diagnosis.summary', report.summary, { minParagraphs: 4 })

  console.log('')
  console.log('=== ③ 完整操作方案（reminder.detail）===')
  // 块 3 之后返回的是 { detail, options, ask }，正文在 .detail 里
  const detailResult = await aiAdapter.generateCareDetail(PLANT, { type: 'watering', interval_days: 3 })
  audit('reminder.detail', detailResult.detail)

  console.log('')
  console.log('=== ④ 下一轮提醒（nextReminder）===')
  const advice = await aiAdapter.generateNextReminderAdvice(PLANT, {
    type: 'fertilizing',
    knowledge: { libraryLabel: '施肥库', interval_days: 10, note: '生长期薄肥勤施' },
    history: ['已完成：施肥（2026-09-21），实际用了/做了：花多多1号'],
    completedAt: new Date().toISOString()
  })
  audit('nextReminder.detail', advice.detail)

  console.log('')
  console.log('=== ⑤ AI 花农对话（chat.gardener）===')
  const chat = await aiAdapter.gardenerChat(
    PLANT, CHAT_CONTEXT, [], '我家月季叶子发黄，是不是该施肥了？'
  )
  audit('chat.gardener', chat.reply)

  console.log('')
  console.log('=== ⑥ 换药建议（treatment.consult）===')
  const consult = await aiAdapter.generateTreatmentAdjustment(PLANT, {
    disease: '黑斑病',
    rounds: [
      { round: 1, plan: '苯醚甲环唑 3000 倍液喷叶背，每 7 天一次，共 3 次', feedback: '斑没有变少' },
      { round: 2, plan: '继续用苯醚甲环唑 3000 倍液', feedback: '新叶上还是会长黑斑' }
    ]
  })
  audit('treatment.consult', consult)

  console.log('')
  if (summary() > 0) process.exit(1)
}

main().catch((err) => {
  fail('脚本异常', (err && err.stack) || String(err))
  process.exit(1)
})
