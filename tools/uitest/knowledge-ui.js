// 实操模拟测试：知识库提醒在真机界面上的表现
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
  const token = getToken()
  const db = openDb()
  const picked = await resolvePlantId(token, { db })
  console.log('用植物 id=' + picked.id + (picked.temp ? '（临时造的）' : '（库里挑的）'))
  let failures = 0

  await miniProgram.reLaunch('/pages/garden/garden')
  await miniProgram.navigateTo('/pages/plant-detail/plant-detail?id=' + picked.id)
  const page = await miniProgram.currentPage()
  await page.waitFor(2500)

  const data = await page.data()
  const pesticide = (data.reminders || []).find((item) => item.type === 'pesticide')
  console.log('列表里的打药提醒：' + (pesticide ? pesticide.summary + ' / 图标 ' + pesticide.icon + ' / ' + pesticide.dueLabel : '未找到'))

  if (!check('每日提醒里出现打药', Boolean(pesticide), true)) failures++
  // 图标早就从 emoji 换成自己的像素图标了（这里是 emoji 时代写死的 🧴），
  // 改成断言"用的是打药那一张"；摘要也不再绑死某一盆植物的名字。
  const iconOk = Boolean(pesticide && /icon-reminder-pesticide/.test(pesticide.icon))
  console.log((iconOk ? 'PASS' : 'FAIL') + ' | 打药图标是打药那张：' + (pesticide && pesticide.icon))
  if (!iconOk) failures++
  // 摘要可能是知识库模板（给XX打药：…），也可能是 AI 重排后的一句话摘要；
  // 断言只要"有一句短摘要、而且不是整段方案"就够了，别绑死某一种来源。
  const summary = (pesticide && pesticide.summary) || ''
  const summaryOk = summary.length > 0 && summary.length <= 40 && !/稀释|倍液/.test(summary)
  console.log((summaryOk ? 'PASS' : 'FAIL') + ' | 打药提醒有一句短摘要：' + summary)
  if (!summaryOk) failures++

  const nodes = await page.$$('.reminder-item')
  const index = (data.reminders || []).findIndex((item) => item.type === 'pesticide')
  await nodes[index].tap()
  await page.waitFor(2500)

  const detail = await miniProgram.currentPage()
  if (!check('打开打药提醒详情', detail.path, 'pages/reminder-detail/reminder-detail')) failures++

  const detailData = await detail.data()
  console.log('详情来源：' + detailData.detailSourceText)
  console.log('按钮文案：' + detailData.generateButtonText)
  console.log('详情开头：' + (detailData.detailText || '').slice(0, 70))

  // 来源可能是知识库，也可能是"AI 已结合这盆植物生成"（这条提醒被重新生成过）
  const sourceOk = /^内容来自 .+库$/.test(detailData.detailSourceText) ||
    detailData.detailSourceText === 'AI 已结合这盆植物生成'
  console.log((sourceOk ? 'PASS' : 'FAIL') + ' | 详情标了来源：' + detailData.detailSourceText)
  if (!sourceOk) failures++
  if (!check('内容已直接展示', detailData.detailText.length > 200, true)) failures++
  if (!check('未触发 AI 生成等待', detailData.generating, false)) failures++

  const shot = path.join(SHOT_DIR, 'pesticide-detail.png')
  await miniProgram.screenshot({ path: shot })
  console.log('screenshot -> ' + shot)

  console.log(failures === 0 ? '\n全部检查通过' : '\n' + failures + ' 项检查未通过')
  await miniProgram.close()
  if (picked.temp) await deletePlant(token, picked.id).catch(() => {})
  db.close()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
