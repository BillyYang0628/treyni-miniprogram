// 实操模拟测试：验证 AI 生成期间的等待提示 UI，并输出截图
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { getToken, openDb, resolvePlantId, deletePlant } = require('./lib')

const SHOT_DIR = path.resolve(__dirname, 'shots')

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

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

  const aiButtons = await page.$$('.mini-btn-ai')
  await aiButtons[0].tap()
  await page.waitFor(1500)
  page = await miniProgram.currentPage()

  // 模拟进入“正在生成诊断报告”的等待状态
  await page.setData({
    loading: true,
    stepText: '正在生成诊断报告（病害介绍和打药方案）...',
    estimateText: '预计 1-3 分钟，请保持页面打开',
    previewDisease: '黑斑病（中等）'
  })
  await page.callMethod('startTimer', '预计 1-3 分钟，请保持页面打开')
  await page.waitFor(6000)

  const data = await page.data()
  console.log('elapsed=' + data.elapsed + '，estimateText=' + data.estimateText +
    '，previewDisease=' + data.previewDisease)

  const bar = await page.$('.loading-bar-inner')
  const diseaseNode = await page.$('.loading-disease')
  const timeNode = await page.$('.loading-time')
  const text = timeNode ? await timeNode.text() : ''

  if (!bar) { failures++; console.log('FAIL | 进度动画元素不存在') } else { console.log('PASS | 进度动画元素存在') }
  if (!diseaseNode) { failures++; console.log('FAIL | 已判断出病害提示不存在') } else { console.log('PASS | 已判断出病害提示存在') }
  if (/已等待 \d+ 秒/.test(text)) { console.log('PASS | 等待秒数文案：' + text) } else { failures++; console.log('FAIL | 等待秒数文案：' + text) }

  const shot1 = path.join(SHOT_DIR, 'diagnosis-loading.png')
  await miniProgram.screenshot({ path: shot1 })
  console.log('screenshot -> ' + shot1)

  await page.callMethod('stopTimer')

  // 返回详情页，截图每日提醒与养护历程
  await miniProgram.navigateBack()
  page = await miniProgram.currentPage()
  await page.waitFor(2500)

  const shot2 = path.join(SHOT_DIR, 'plant-detail-after-diagnosis.png')
  await miniProgram.screenshot({ path: shot2 })
  console.log('screenshot -> ' + shot2)

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
