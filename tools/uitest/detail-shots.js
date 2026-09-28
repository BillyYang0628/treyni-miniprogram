// 实操模拟测试：为提醒详情页 / 养护记录详情页截图，便于人工核对排版
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { getToken, openDb, resolvePlantId, findReminderId, findJournalId, deletePlant } = require('./lib')

const SHOT_DIR = path.resolve(__dirname, 'shots')

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  const token = getToken()
  const db = openDb()

  // id 不再写死（原来是 PLANT_ID = 6 / 提醒 id = 25），改成自动挑
  const picked = await resolvePlantId(token, { db })
  const reminderId = findReminderId(db, { plantId: picked.id, minDetailLength: 200 })
  const journalId = findJournalId(db, picked.id)
  console.log('植物 id=' + picked.id + '｜提醒 id=' + reminderId + '｜日记 id=' + journalId)
  if (!reminderId || !journalId) {
    throw new Error('库里缺少可截图的详情报文或养护日记（先用截图脚本造一盆，或跑 detail-pages.js）')
  }

  await miniProgram.reLaunch('/pages/garden/garden')
  await miniProgram.navigateTo('/pages/plant-detail/plant-detail?id=' + picked.id)
  let page = await miniProgram.currentPage()
  await page.waitFor(2500)
  await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'list-summary.png') })

  await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + reminderId)
  page = await miniProgram.currentPage()
  await page.waitFor(2500)
  await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'reminder-detail.png') })

  await miniProgram.navigateBack()
  await page.waitFor(1500)
  await miniProgram.navigateTo('/pages/journal-detail/journal-detail?id=' + journalId)
  page = await miniProgram.currentPage()
  await page.waitFor(2000)
  await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'journal-detail.png') })

  console.log('screenshots written to ' + SHOT_DIR)
  if (picked.temp) await deletePlant(token, picked.id).catch(() => {})
  db.close()
  await miniProgram.close()
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
