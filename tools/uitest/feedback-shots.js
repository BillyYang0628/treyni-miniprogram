// 实操模拟测试：截取用药效果询问界面（只读，不改变数据）
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { getToken, openDb, createTempPlant, deletePlant, seedTreatmentPair } = require('./lib')

const SHOT_DIR = path.resolve(__dirname, 'shots')

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  const token = getToken()
  const db = openDb()
  // 原来的 FEEDBACK_REMINDER_ID = 79 早就没了，改成现场造一条待反馈
  const plantId = await createTempPlant(token, '反馈截图', '月季')
  const pair = seedTreatmentPair(db, plantId, 1, 1, 'ui-shot', '黑斑病')
  const FEEDBACK_REMINDER_ID = pair.feedbackId

  await miniProgram.reLaunch('/pages/garden/garden')
  await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + FEEDBACK_REMINDER_ID)
  const page = await miniProgram.currentPage()
  await page.waitFor(2500)

  const shot = path.join(SHOT_DIR, 'feedback-ask.png')
  await miniProgram.screenshot({ path: shot })
  console.log('screenshot -> ' + shot)

  await deletePlant(token, plantId).catch(() => {})
  db.close()
  await miniProgram.close()
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
