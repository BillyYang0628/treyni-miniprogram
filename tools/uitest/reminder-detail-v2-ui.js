// 实操模拟测试：提醒详情界面改进
// 1) 完整操作方案按条展示并配图标
// 2) 方案下方有“根据已知条件生成”的提示
// 3) 稀释倍数带家庭可操作换算
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')

const SHOT_DIR = path.resolve(__dirname, 'shots')
const PESTICIDE_REMINDER = 125 // 植物 6 的打药提醒
const WATERING_REMINDER = 62 // 植物 6 的浇水提醒

function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  return ok
}

async function openReminder(miniProgram, id) {
  await miniProgram.reLaunch('/pages/garden/garden')
  await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + id)
  const page = await miniProgram.currentPage()
  await page.waitFor(2500)
  return page
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  let failures = 0

  // 打药提醒：条目 + 图标 + 稀释换算
  let page = await openReminder(miniProgram, PESTICIDE_REMINDER)
  let data = await page.data()

  console.log('打药方案条数：' + data.detailItems.length)
  data.detailItems.forEach((item) => console.log('  ' + item.icon + ' ' + item.text.slice(0, 40)))

  if (!check('方案已按条拆分', data.detailItems.length >= 3, true)) failures++
  if (!check('每条都有图标', data.detailItems.every((item) => item.icon.length > 0), true)) failures++
  if (!check('出现警示图标', data.detailItems.some((item) => item.icon === '⚠️'), true)) failures++

  const pesticideText = data.detailItems.map((item) => item.text).join('')
  console.log('是否含稀释换算：' + /1 克药兑/.test(pesticideText))
  if (!check('稀释倍数带换算', /1 克药兑/.test(pesticideText), true)) failures++

  const itemNodes = await page.$$('.detail-item')
  if (!check('图标条目已渲染', itemNodes.length, data.detailItems.length)) failures++

  const note = await page.$('.detail-note')
  const noteText = note ? await note.text() : ''
  console.log('方案提示：' + noteText.replace(/\s+/g, ' ').slice(0, 60) + '…')
  if (!check('方案下方有说明提示', noteText.includes('如果盆土'), true)) failures++

  await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'reminder-detail-v2.png') })

  // 浇水提醒：判断/操作/别踩坑/季节 四类图标
  page = await openReminder(miniProgram, WATERING_REMINDER)
  data = await page.data()
  console.log('\n浇水方案条数：' + data.detailItems.length)
  data.detailItems.forEach((item) => console.log('  ' + item.icon + ' ' + item.text.slice(0, 30)))

  const icons = data.detailItems.map((item) => item.icon)
  if (!check('判断条带放大镜', icons.includes('🔍'), true)) failures++
  if (!check('操作条带工具', icons.includes('🛠️'), true)) failures++
  if (!check('踩坑条带警示', icons.includes('⚠️'), true)) failures++

  await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'reminder-detail-watering.png') })

  console.log(failures === 0 ? '\n全部检查通过' : '\n' + failures + ' 项检查未通过')
  await miniProgram.close()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
