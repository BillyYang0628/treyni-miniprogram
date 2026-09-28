// 实操模拟测试：第 3 板块界面
// 1) 添加植物页：种下日期是日历选择，苗情阶段/来源/是否刚换盆齐全
// 2) 对话页：输入框是固定高度的大文本框、发送与结束对话同排对称
// 3) 生成时显示当前任务阶段
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { getToken, openDb, resolvePlantId, deletePlant } = require('./lib')
const SHOT_DIR = path.resolve(__dirname, 'shots')

function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  return ok
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  // 对话页需要一盆植物（原来写死 CHAT_PLANT_ID = 49）
  const token = getToken()
  const db = openDb()
  const picked = await resolvePlantId(token, { db })
  const CHAT_PLANT_ID = picked.id
  console.log('对话页用植物 id=' + CHAT_PLANT_ID + (picked.temp ? '（临时造的）' : '（库里挑的）'))
  let failures = 0

  // 1) 添加植物页
  await miniProgram.reLaunch('/pages/garden/garden')
  await miniProgram.navigateTo('/pages/plant-form/plant-form')
  let page = await miniProgram.currentPage()
  await page.waitFor(3000)

  const pickers = await page.$$('picker')
  console.log('页面上的选择器数量：' + pickers.length)
  if (!check('至少有品种/日期/苗情/来源四个选择器', pickers.length >= 4, true)) failures++

  let data = await page.data()
  console.log('苗情选项：' + data.growthStageOptions.join('、'))
  console.log('来源选项：' + data.plantSourceOptions.join('、'))
  if (!check('有苗情选项', data.growthStageOptions.length >= 5, true)) failures++
  if (!check('有来源选项', data.plantSourceOptions.length >= 4, true)) failures++
  if (!check('默认带今天日期', data.today.length, 10)) failures++

  // 模拟选择日期与苗情
  await page.callMethod('onDateChange', { detail: { value: '2026-09-13' } })
  await page.callMethod('onGrowthStageChange', { detail: { value: 1 } })
  await page.callMethod('onPlantSourceChange', { detail: { value: 0 } })
  await page.callMethod('onTransplantChange', { detail: { value: true } })
  await page.waitFor(1000)

  data = await page.data()
  console.log('选择后：' + JSON.stringify({
    planting_date: data.planting_date,
    growth_stage: data.growth_stage,
    plant_source: data.plant_source,
    is_recent_transplant: data.is_recent_transplant
  }))
  if (!check('日期已选', data.planting_date, '2026-09-13')) failures++
  if (!check('苗情已选', data.growth_stage, '小苗')) failures++
  if (!check('来源已选', data.plant_source, '网购')) failures++
  if (!check('换盆开关已开', data.is_recent_transplant, 1)) failures++

  await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'plant-form-stage.png') })

  // 2) 对话页输入区
  await miniProgram.reLaunch('/pages/garden/garden')
  await miniProgram.navigateTo('/pages/chat/chat?plant_id=' + CHAT_PLANT_ID)
  page = await miniProgram.currentPage()
  await page.waitFor(3000)

  const textarea = await page.$('.chat-textarea')
  if (!check('输入框是 textarea', Boolean(textarea), true)) failures++

  const size = await textarea.size()
  const box = await textarea.offset()
  console.log('输入框尺寸：' + Math.round(size.width) + ' × ' + Math.round(size.height) + 'px，左边距 ' + Math.round(box.left))
  if (!check('高度是原来的两倍（≥80px）', size.height >= 80, true)) failures++
  if (!check('横向接近满屏（≥330px）', size.width >= 330, true)) failures++
  if (!check('左右有间隙', box.left >= 8, true)) failures++

  const oldInput = await page.$('.chat-input')
  if (!check('旧的单行输入框已移除', Boolean(oldInput), false)) failures++

  // 发送与结束对话同排
  const actionButtons = await page.$$('.chat-action')
  if (!check('底部有两个按钮', actionButtons.length, 2)) failures++

  const first = await actionButtons[0].offset()
  const second = await actionButtons[1].offset()
  const firstSize = await actionButtons[0].size()
  const secondSize = await actionButtons[1].size()
  console.log('发送按钮 top=' + Math.round(first.top) + '，结束按钮 top=' + Math.round(second.top))
  console.log('宽度：' + Math.round(firstSize.width) + ' / ' + Math.round(secondSize.width))
  if (!check('两个按钮在同一行', Math.abs(first.top - second.top) <= 2, true)) failures++
  if (!check('两个按钮等宽对称', Math.abs(firstSize.width - secondSize.width) <= 2, true)) failures++

  // 3) 生成阶段提示
  await page.callMethod('startTimer', [
    '🔍 正在翻看这盆月季的档案…',
    '📚 正在查这个品种的养护知识…',
    '🧪 正在核对用药与施肥方案…',
    '🌿 正在想适合它现在状态的做法…',
    '✍️ 正在把建议整理成话…'
  ])
  await page.waitFor(1500)
  let stage = (await page.data()).stageText
  console.log('第 1 阶段：' + stage)
  if (!check('显示第 1 阶段', stage.includes('翻看'), true)) failures++

  await page.waitFor(7000)
  stage = (await page.data()).stageText
  console.log('7 秒后：' + stage)
  if (!check('阶段会推进', stage.includes('查这个品种'), true)) failures++

  await page.callMethod('stopTimer')
  await page.setData({
    sending: true,
    elapsed: 18,
    estimateText: '预计 30-90 秒，请稍等',
    stageText: '🧪 正在核对用药与施肥方案…'
  })
  await page.waitFor(1000)
  await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'chat-stage.png') })
  await page.setData({ sending: false, stageText: '' })

  console.log(failures === 0 ? '\n全部检查通过' : '\n' + failures + ' 项检查未通过')
  await miniProgram.close()
  if (picked.temp) await deletePlant(token, CHAT_PLANT_ID).catch(() => {})
  db.close()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
