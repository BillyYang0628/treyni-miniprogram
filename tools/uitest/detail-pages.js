// 实操模拟测试：验证提醒详情页 / 养护记录详情页，以及列表摘要与三行截断
const automator = require('miniprogram-automator')
const { getToken, api, openDb, createTempPlant, deletePlant, resolvePlantId } = require('./lib')

// 植物不再写死：自动挑一盆「有详情报文 + 有养护日记」的植物
// （原来写的是 PLANT_ID = 6，库清过一次之后脚本直接失效）
const THREE_LINE_MAX_PX = 120

function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  return ok
}

async function main() {
  const token = getToken()
  const db = openDb()
  let tempPlantId = null
  let resolvedPlantId = null
  let pickedTempPlantId = null
  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  let failures = 0

  const picked = await resolvePlantId(token, { db })
  resolvedPlantId = picked.id
  if (picked.temp) {
    pickedTempPlantId = picked.id
    console.log('注意：库里没有「有详情报文」的植物，这次用临时植物跑，前几项断言可能不成立')
  }
  console.log('用植物 id=' + picked.id + (picked.temp ? '（临时造的）' : '（库里挑的）'))

  await miniProgram.reLaunch('/pages/garden/garden')
  await miniProgram.navigateTo('/pages/plant-detail/plant-detail?id=' + resolvedPlantId)
  let page = await miniProgram.currentPage()
  await page.waitFor(2500)

  // 1) 每日提醒列表只显示摘要
  const descNodes = await page.$$('.reminder-desc')
  const firstDesc = descNodes.length ? await descNodes[0].text() : ''
  console.log('列表摘要示例：' + firstDesc)
  if (!check('提醒列表显示一句话摘要', firstDesc.length > 0 && firstDesc.length <= 40, true)) failures++
  if (!check('摘要不含 AI 详情编号', /1\)|稀释|倍液/.test(firstDesc), false)) failures++

  // 2) 养护历程列表最多三行
  const contentNodes = await page.$$('.journal-content')
  let maxHeight = 0
  for (const node of contentNodes) {
    const size = await node.size()
    if (size.height > maxHeight) maxHeight = size.height
  }
  console.log('养护历程最长渲染高度：' + Math.round(maxHeight) + 'px（阈值 ' + THREE_LINE_MAX_PX + 'px）')
  if (!check('养护历程列表不超过三行', maxHeight > 0 && maxHeight <= THREE_LINE_MAX_PX, true)) failures++

  // 3) 点击提醒进入详情页，看到完整内容
  const listData = await page.data()
  const index = (listData.reminders || []).findIndex((item) => item.has_detail)
  const reminderNodes = await page.$$('.reminder-item')
  console.log('已有详细方案的提醒在列表中的位置：' + index)
  if (!check('存在已缓存详细方案的提醒', index >= 0, true)) failures++

  await reminderNodes[index].tap()
  await page.waitFor(2000)
  let detailPage = await miniProgram.currentPage()
  if (!check('点击提醒打开详情页', detailPage.path, 'pages/reminder-detail/reminder-detail')) failures++

  const reminderDetail = await detailPage.data()
  const detailText = (reminderDetail.detailText || '')
  console.log('详情内容长度：' + detailText.length)
  console.log('详情开头：' + detailText.slice(0, 80))
  if (!check('提醒详情有完整方案', detailText.length > 200, true)) failures++
  if (!check('详情页显示植物归属', Boolean(reminderDetail.plant && reminderDetail.plant.name), true)) failures++
  if (!check('详情内容比列表摘要长得多', detailText.length > reminderDetail.summary.length * 3, true)) failures++

  // 4) 返回后点击养护历程进入记录详情
  await miniProgram.navigateBack()
  page = await miniProgram.currentPage()
  await page.waitFor(2000)

  const journalNodes = await page.$$('.journal-body')
  await journalNodes[0].tap()
  await page.waitFor(2000)
  const journalPage = await miniProgram.currentPage()
  if (!check('点击养护历程打开详情页', journalPage.path, 'pages/journal-detail/journal-detail')) failures++

  const journalDetail = await journalPage.data()
  const journalText = (journalDetail.journal && journalDetail.journal.content) || ''
  console.log('养护记录类型：' + journalDetail.typeText + '，时间：' + journalDetail.timeText)
  console.log('养护记录内容长度：' + journalText.length)
  if (!check('记录详情显示中文时间', /月|日/.test(journalDetail.timeText || ''), true)) failures++
  if (!check('记录详情有内容', journalText.length > 0, true)) failures++

  // 5) 知识库没有的品种：首次打开提醒时自动用 AI 生成方案
  await miniProgram.navigateBack()
  await page.waitFor(1500)

  tempPlantId = await createTempPlant(token, 'AI生成测试', '火星植物')

  const list = await api('/plants/' + tempPlantId + '/reminders', {}, token)
  const target = list.reminders.find((item) => item.type === 'watering' && item.status === 'pending')
  console.log('临时植物浇水提醒 id=' + target.id + '，has_detail=' + target.has_detail)
  if (!check('未知品种没有知识库详情', target.has_detail, false)) failures++

  await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + target.id)
  detailPage = await miniProgram.currentPage()
  await detailPage.waitFor(3000)

  const started = await detailPage.data()
  console.log('首次打开浇水提醒：generating=' + started.generating + '，' + started.estimateText)
  if (!check('首次打开自动进入生成状态', started.generating, true)) failures++

  const deadline = Date.now() + 320000
  let finished = false
  while (Date.now() < deadline) {
    await detailPage.waitFor(5000)
    const now = await detailPage.data()
    console.log('  生成中：已等待 ' + now.elapsed + ' 秒')
    if (!now.generating) {
      finished = true
      console.log('生成完成，方案长度：' + (now.detailText || '').length)
      console.log('方案开头：' + (now.detailText || '').slice(0, 80))
      if (!check('AI 生成的方案足够详尽', (now.detailText || '').length > 300, true)) failures++
      if (!check('生成过程中未报错', !now.error, true)) failures++
      break
    }
  }
  if (!finished) {
    failures++
    console.log('FAIL | 方案在 320 秒内未生成完成')
  }

  if (tempPlantId) {
    await deletePlant(token, tempPlantId)
    const left = db.prepare('SELECT COUNT(*) AS c FROM plant_reminders WHERE plant_id = ?').get(tempPlantId).c
    console.log('清理临时植物：剩余提醒 ' + left + ' 条')
    if (!check('临时植物数据已清理', left, 0)) failures++
  }
  if (pickedTempPlantId) {
    await deletePlant(token, pickedTempPlantId)
    console.log('清理走查用的临时植物 id=' + pickedTempPlantId)
  }
  db.close()

  console.log(failures === 0 ? '\n全部检查通过' : '\n' + failures + ' 项检查未通过')
  await miniProgram.close()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
