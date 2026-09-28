// 排查完成面板：点「完成」之后组件到底有没有渲染出来
const automator = require('miniprogram-automator')
const { getToken, api, createTempPlant, deletePlant } = require('./lib')

async function main() {
  const token = getToken()
  const plantId = await createTempPlant(token, '面板排查', '月季')
  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })

  try {
    let list = null
    for (let i = 0; i < 20; i++) {
      list = await api('/plants/' + plantId + '/reminders', {}, token)
      if ((list.reminders || []).length >= 4) break
      await new Promise((r) => setTimeout(r, 1000))
    }

    await miniProgram.reLaunch('/pages/garden/garden')
    await miniProgram.navigateTo('/pages/plant-detail/plant-detail?id=' + plantId)
    const page = await miniProgram.currentPage()
    await page.waitFor(5000)

    const buttons = await page.$$('.reminder-actions .mini-btn')
    console.log('列表按钮数：' + buttons.length)
    for (const b of buttons) {
      if ((await b.text()).trim() === '完成') { await b.tap(); break }
    }
    await page.waitFor(1500)

    const data = await page.data()
    console.log('sheetShow=' + data.sheetShow + '  sheetReminder=' + JSON.stringify(data.sheetReminder && { id: data.sheetReminder.id, type: data.sheetReminder.type }))

    const comp = await page.$('complete-sheet')
    console.log('页面里有没有 complete-sheet 节点：' + Boolean(comp))
    if (comp) {
      const inner = await comp.$$('.sheet-panel')
      console.log('  组件内部能找到 .sheet-panel 吗：' + inner.length)
      const opts = await comp.$$('.cs-option')
      console.log('  组件内部能找到 .cs-option 吗：' + opts.length)
    }
    const direct = await page.$$('.cs-option')
    console.log('页面直接选 .cs-option 能选到几个：' + direct.length)
  } finally {
    await miniProgram.close().catch(() => {})
    await deletePlant(token, plantId).catch(() => {})
  }
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
