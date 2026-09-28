/**
 * 提示词块 5 · AI 花农对话降长（A-5 批注 6）
 *
 * 背景：实跑那次「每天只有 4 小时光照」的回复 765 字、6 个要点，
 * 用户原话是「以学生的注意力很难看完」。
 * 这一期加的是取舍规则：先给结论、最多 3 个要点、全文 300 字，
 * 但**安全类内容不许为了短而删**，所以最后一条是反向断言。
 *
 * 用法：node verify-chat-brevity.js
 */
const path = require('node:path')
const { SERVER_DIR, loadEnv, check, checkTruthy, fail, countChars, maxCircledNumber, median, summary } =
  require('./ai-lib')

loadEnv()
const aiAdapter = require(path.join(SERVER_DIR, 'src/services/aiAdapter.js'))

const PLANT = {
  name: '阳台那盆月季',
  species: '月季',
  variety: '微型月季',
  pot_size: '15 厘米口径',
  soil_type: '通用营养土',
  location: '南阳台',
  light_environment: '每天大约 4 小时直射光'
}

const CONTEXT = {
  profile: {
    variety: '微型月季',
    pot_size: '15 厘米口径',
    soil_type: '通用营养土',
    location: '南阳台',
    light_environment: '每天大约 4 小时直射光',
    planting_date: '2026-04-01'
  },
  reminders: [
    { title: '给月季浇水', type: 'watering', interval_days: 3, due_at: '2026-09-21' },
    { title: '给月季施肥', type: 'fertilizing', interval_days: 14, due_at: '2026-09-27' },
    { title: '给月季打一次药', type: 'pesticide', interval_days: 7, due_at: '2026-09-22' }
  ],
  careRules: [
    {
      library: '浇水库',
      type: 'watering',
      interval_days: 3,
      note: '见干见湿',
      detail: '月季喜光喜肥，盆土表面发白再浇透，一次浇到盆底流出水为止。夏天一天一次，冬天三五天一次。'
    }
  ],
  environment: { light: '喜光，每天至少 5-6 小时直射', temperature: '15-26℃ 最适宜' }
}

// 这 5 个都是普通养护问题（不含用药安全），应该走「短」那条规则
const QUESTIONS = [
  '我家月季每天只有 4 小时光照，需要改档案吗？',
  '叶子有点发黄，是缺水吗？',
  '现在这个季节多久浇一次水合适？',
  '我想让月季多开花，需要做什么？',
  '花盆底下要不要垫托盘？'
]

async function ask(question) {
  const result = await aiAdapter.gardenerChat(PLANT, CONTEXT, [], question)
  return String(result.reply || '')
}

async function main() {
  console.log('=== ① 五个普通问题的长度 ===')
  const counts = []

  for (const question of QUESTIONS) {
    const reply = await ask(question)
    const chars = countChars(reply)
    const points = maxCircledNumber(reply)
    counts.push(chars)
    console.log('  ' + chars + ' 字｜要点 ' + points + ' 个｜' + question)
  }

  const maxChars = Math.max(...counts)
  const mid = median(counts)
  console.log('  → 中位数 ' + mid + ' 字，最长 ' + maxChars + ' 字')

  check('回复字数中位数不超过 300', mid <= 300, true)
  check('最长的一条不超过 450', maxChars <= 450, true)

  console.log('')
  console.log('=== ② 安全类：压短不能把安全信息删掉（反向断言）===')
  const safetyReply = await ask('我家月季叶背有红蜘蛛，我准备自己配药打一次，要注意什么？')
  console.log('  ' + countChars(safetyReply) + ' 字')
  console.log('  ' + safetyReply.replace(/\n+/g, ' / '))

  const SAFETY_SIGNS = ['家长', '口罩', '手套', '远离', '不要碰']
  const hit = SAFETY_SIGNS.find((word) => safetyReply.includes(word))
  checkTruthy('安全回复里保留了安全信息', hit, '命中=' + (hit || '无'))

  if (summary() > 0) process.exit(1)
}

main().catch((err) => {
  fail('脚本异常', (err && err.stack) || String(err))
  process.exit(1)
})
