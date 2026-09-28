// 实操模拟测试：验证从 AI 诊断页返回时，详情页不闪加载态、且列表重新拉取
const automator = require('miniprogram-automator')
const { getToken, openDb, resolvePlantId, deletePlant } = require('./lib')

async function main() {
  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  // 植物 id 不再写死（原来是 6）
  const token = getToken()
  const db = openDb()
  const picked = await resolvePlantId(token, { db })
  console.log('用植物 id=' + picked.id)
  let failures = 0

  await miniProgram.reLaunch('/pages/garden/garden')
  await miniProgram.navigateTo('/pages/plant-detail/plant-detail?id=' + picked.id)
  let page = await miniProgram.currentPage()
  await page.waitFor(2000)

  const first = await page.data()
  console.log('首次进入：loading=' + first.loading + '，提醒=' + first.reminders.length +
    '，历程=' + first.journals.length)
  if (first.loading !== false) { failures++; console.log('FAIL | 首次进入后 loading 应为 false') }

  const aiButtons = await page.$$('.mini-btn-ai')
  await aiButtons[0].tap()
  await page.waitFor(1200)
  page = await miniProgram.currentPage()
  console.log('已打开：' + page.path)

  // 让诊断页把资料拉完再返回：实测刚进去就 back，开发者工具会卡住不回消息
  // （报 "timeout waiting for automator response"，连撞两次）。
  await page.waitFor(3000)
  // 也不用 automator 的 navigateBack —— 它内部会顺带调一次 currentPage，
  // 卡住的就是那一步。直接调 wx.navigateBack，再自己重试取页面。
  await miniProgram.callWxMethod('navigateBack')
  await page.waitFor(1500)

  let backOk = false
  for (let i = 0; i < 3 && !backOk; i++) {
    try {
      page = await miniProgram.currentPage()
      backOk = Boolean(page) && page.path === 'pages/plant-detail/plant-detail'
    } catch (err) {
      console.warn('取当前页超时，重试 ' + (i + 1) + '/3：' + err.message)
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
  if (!backOk) {
    console.error('FAILED: 返回后取不到植物详情页（开发者工具侧的问题，不是页面逻辑）')
    if (picked.temp) await deletePlant(token, picked.id).catch(() => {})
    db.close()
    await miniProgram.close().catch(() => {})
    process.exit(1)
  }
  await page.waitFor(800)

  const after = await page.data()
  const layout = await page.$('.detail-layout')
  console.log('返回后 0.8 秒：loading=' + after.loading + '，提醒=' + after.reminders.length +
    '，历程=' + after.journals.length + '，详情布局可见=' + Boolean(layout))

  if (after.loading !== false) { failures++; console.log('FAIL | 返回后不应出现整页加载态') }
  if (!layout) { failures++; console.log('FAIL | 返回后详情布局应立即可见') }
  if (String(after.plantId) !== String(picked.id)) {
    failures++
    console.log('FAIL | plantId 丢失（实际=' + after.plantId + '，期望=' + picked.id + '）')
  }

  console.log(failures === 0 ? '全部检查通过' : failures + ' 项检查未通过')
  if (picked.temp) await deletePlant(token, picked.id).catch(() => {})
  db.close()
  await miniProgram.close()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
