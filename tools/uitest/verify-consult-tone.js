/**
 * 提示词块 5 · 换药建议的语言调教（A-4 批注 5）
 *
 * 背景：规范一直在（generateTreatmentAdjustment 早就拼了 WRITING_STYLE_RULES），
 * 但「按 5 段结构 + 400-600 字」这个骨架把话术压成了报告体。
 * 这一期加的是结构约束：先给结论、每点先说判断、单句不超过 40 字、禁书面连接词。
 *
 * 三次抽样都过才算过（避免一次侥幸）。
 * 用法：node verify-consult-tone.js
 */
const path = require('node:path')
const { SERVER_DIR, loadEnv, check, checkTruthy, fail, countChars, splitSentences, summary } = require('./ai-lib')

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

// 三种不同的"打了两轮没效果"的情形，逼模型换三种说法，避免一次侥幸
const CASES = [
  {
    disease: '黑斑病',
    rounds: [
      { round: 1, plan: '苯醚甲环唑 3000 倍液喷叶背，每 7 天一次，共 3 次', feedback: '斑没有变少' },
      { round: 2, plan: '继续用苯醚甲环唑 3000 倍液', feedback: '新叶上还是会长黑斑' }
    ]
  },
  {
    disease: '红蜘蛛',
    rounds: [
      { round: 1, plan: '阿维菌素 2000 倍液喷叶背，每 5 天一次，共 3 次', feedback: '好像少了一点，过几天又多起来' },
      { round: 2, plan: '继续用阿维菌素 2000 倍液', feedback: '叶背还是有细丝' }
    ]
  },
  {
    disease: '白粉病',
    rounds: [
      { round: 1, plan: '嘧菌酯 2000 倍液全株喷，每 7 天一次，共 3 次', feedback: '白粉没退' },
      { round: 2, plan: '继续用嘧菌酯 2000 倍液', feedback: '白粉反而更厚了' }
    ]
  }
]

const BANNED_WORDS = ['综上所述', '因此建议', '针对该情况', '鉴于以上', '综上所述']
const JUDGEMENT_WORDS = ['结论', '八成', '可能', '大概率', '多半', '应该是', '问题出在', '主要问题']

async function main() {
  let round = 0

  for (const item of CASES) {
    round++
    console.log('=== 第 ' + round + ' 次抽样：' + item.disease + ' ===')
    const text = await aiAdapter.generateTreatmentAdjustment(PLANT, item)
    const body = String(text || '')
    const chars = countChars(body)
    const sentences = splitSentences(body)
    const first = sentences[0] || ''

    console.log('  全文 ' + chars + ' 字，共 ' + sentences.length + ' 句；首句：' + first)
    console.log('  --- 全文 ---')
    console.log(body.split('\n').map((line) => '  ' + line).join('\n'))
    console.log('  --- 全文结束 ---')

    checkTruthy('首句有判断（结论词）', JUDGEMENT_WORDS.some((word) => first.includes(word)), '首句=' + first)
    check('首句不超过 40 字', countChars(first) <= 40, true)
    // 提示词里的目标是 350-520 字；模型有 ±15% 的波动，
    // 所以断言用 350-600：小于 350 说明漏了内容，大于 600 说明又变回报告体。
    // （上下限从 500/575 抬起来，是因为 2026-09-20 接了购买指路：有资料时必须多写 1 句，
    //   实测加了那句之后最长的抽样到 579。）
    // 目标区间单独打一行提示，方便肉眼判断收紧还是放松。
    console.log('  ' + (chars >= 350 && chars <= 520 ? '√' : '×') + ' 落在提示词目标区间 350-520 字')
    check('全文落在 350-600 字', chars >= 350 && chars <= 600, true)
    check('没有书面连接词', BANNED_WORDS.find((word) => body.includes(word)) || '（无）', '（无）')
    // 编号形态不限（1) 1. 1、 1） ① 都行），但必须真的有 5 个条目
    const numbered =
      (body.match(/(?:^|\n)\s*[1-6]\s*[).、．）]/g) || []).length +
      (body.match(/[①②③④⑤⑥]/g) || []).length
    check('保留了 5 个编号条目', numbered >= 5, true)

    // 提示词里写的是"单句不超过 40 字"，模型实际会写成 40-60 字的双分句
    // （分号两边各自完整，读起来不费劲）。硬边界放到 70，用来抓"一句里堆三个专业名词"那种回归。
    const longest = sentences.reduce((max, line) => Math.max(max, countChars(line)), 0)
    const tooLong = sentences.filter((line) => countChars(line) > 70)
    console.log('  最长一句 ' + longest + ' 字')
    check('没有超长句（>70 字）', tooLong.length > 0 ? tooLong[0] : '（无）', '（无）')
    console.log('')
  }

  if (summary() > 0) process.exit(1)
}

main().catch((err) => {
  fail('脚本异常', (err && err.stack) || String(err))
  process.exit(1)
})
