// 实操模拟测试：施肥提醒详情页显示施肥库内容
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { openDb, findReminderId } = require('./lib')

const SHOT_DIR = path.resolve(__dirname, 'shots')

function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  return ok
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  // 提醒 id 不再写死（原来是 25）：自动挑一条施肥提醒
  const db = openDb()
  const FERTILIZING_REMINDER_ID = findReminderId(db, { type: 'fertilizing' })
  db.close()
  if (!FERTILIZING_REMINDER_ID) {
    console.error('FAILED: 库里没有施肥提醒，先跑一次 detail-pages.js 或手工加一盆植物')
    process.exit(1)
  }
  console.log('用施肥提醒 id=' + FERTILIZING_REMINDER_ID)
  let failures = 0

  await miniProgram.reLaunch('/pages/garden/garden')
  await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + FERTILIZING_REMINDER_ID)
  const page = await miniProgram.currentPage()
  await page.waitFor(2500)

  const data = await page.data()
  console.log('来源提示：' + data.detailSourceText)
  console.log('按钮文案：' + data.generateButtonText)
  console.log('详情开头：' + (data.detailText || '').slice(0, 60))

  if (!check('提示内容来自施肥库', data.detailSourceText, '内容来自 施肥库')) failures++
  if (!check('内容已直接展示', data.detailText.length > 200, true)) failures++
  if (!check('未触发 AI 等待', data.generating, false)) failures++

  const shot = path.join(SHOT_DIR, 'fertilizing-detail.png')
  await miniProgram.screenshot({ path: shot })
  console.log('screenshot -> ' + shot)

  console.log(failures === 0 ? '\n全部检查通过' : '\n' + failures + ' 项检查未通过')
  await miniProgram.close()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
