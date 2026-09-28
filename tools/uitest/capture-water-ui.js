// 拍「土壤水分基准」的界面：
//   water-baseline-need.png  第一次进来，提示先确认土壤状态
//   water-baseline-set.png   选了「已经干透」之后，数字按基准重算
// 顺带把植物详情、添加植物页也截一张（插画换 PNG 之后的确认）。
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { getToken, api, createTempPlant, deletePlant } = require('./lib')

const SHOT_DIR = path.resolve(__dirname, 'shots-art')

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const token = getToken()
  const plantId = await createTempPlant(token, '水基准截图', '月季')
  let miniProgram = null

  try {
    const list = await api('/plants/' + plantId + '/reminders', {}, token)
    const watering = list.reminders.find((r) => r.type === 'watering')
    if (!watering) throw new Error('临时植物没有浇水提醒')

    // 等后台把水分数值算出来
    let waited = 0
    while (waited < 60000) {
      const probe = await api('/reminders/' + watering.id, {}, token)
      if (probe.reminder.water) break
      await new Promise((resolve) => setTimeout(resolve, 2000))
      waited += 2000
    }

    miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
    await miniProgram.reLaunch('/pages/garden/garden')
    await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + watering.id)
    const page = await miniProgram.currentPage()
    await page.waitFor(5000)

    const data = await page.data()
    console.log('需要确认基准: ' + data.needsWaterBaseline)
    console.log('当前水分: ' + data.waterPercentText)
    await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'water-baseline-need.png') })

    // 点「已经干透」
    const btns = await page.$$('.baseline-btn')
    console.log('确认卡上的选项数: ' + btns.length)
    for (const b of btns) {
      const label = (await b.text()).trim()
      if (label === '已经干透') { await b.tap(); break }
    }
    await page.waitFor(6000)

    const after = await page.data()
    console.log('确认后水分: ' + after.waterPercentText)
    console.log('说明文字: ' + after.waterBaselineText)
    await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'water-baseline-set.png') })

    // 添加植物页：横幅插画换成 PNG 之后确认能显示
    await miniProgram.navigateTo('/pages/plant-form/plant-form')
    await miniProgram.currentPage().then((p) => p.waitFor(2500))
    await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'plant-form-banner.png') })
  } finally {
    if (miniProgram) await miniProgram.close().catch(() => {})
    await deletePlant(token, plantId).catch((err) => console.log('清理失败：' + err.message))
  }
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
