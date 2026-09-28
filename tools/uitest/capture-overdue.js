// 拍「逾期提醒」的界面，用来做渐变色的改动前后对照。
//
// 做法：建一盆临时植物，把它的几条提醒的 due_at 直接改到过去（不同天数），
// 这样能在一次截图里同时看到「正常 / 逾期 1 天 / 3 天 / 7 天 / 12 天」。
// 用完把植物删掉，不动你已有的数据。
//
// 用法：node capture-overdue.js [输出前缀，默认 overdue]
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { getToken, api, createTempPlant, deletePlant, openDb } = require('./lib')

const SHOT_DIR = path.resolve(__dirname, 'shots-art')
const PREFIX = process.argv[2] || 'overdue'

/** 把某条提醒的 due_at 挪到 N 天前 */
function backdate(db, reminderId, daysAgo) {
  const at = new Date(Date.now() - daysAgo * 86400000)
  db.prepare('UPDATE plant_reminders SET due_at = ? WHERE id = ?').run(at.toISOString(), reminderId)
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const token = getToken()
  const plantId = await createTempPlant(token, '逾期样式演示', '月季')
  const db = openDb()
  let miniProgram = null

  try {
    // 等默认提醒建好
    let list = null
    for (let i = 0; i < 20; i++) {
      list = await api('/plants/' + plantId + '/reminders', {}, token)
      if ((list.reminders || []).length >= 4) break
      await new Promise((r) => setTimeout(r, 1000))
    }

    const byType = {}
    for (const r of list.reminders) byType[r.type] = r

    // 三条默认提醒分别改到 1 / 3 / 7 天前，浇水保持未来（作为"正常"对照）
    if (byType.fertilizing) backdate(db, byType.fertilizing.id, 1)
    if (byType.pesticide) backdate(db, byType.pesticide.id, 3)
    if (byType.pruning) backdate(db, byType.pruning.id, 7)

    // 再补两条自定义提醒，凑出 2 天和 12 天（12 天用来验证"封顶后不再变深"）
    const extra = []
    for (const [title, days] of [['补一次叶面水', 2], ['检查支架', 12]]) {
      const created = await api('/plants/' + plantId + '/reminders', {
        method: 'POST',
        body: {
          type: 'custom',
          title,
          content: '演示用的自定义提醒',
          due_at: new Date(Date.now() - days * 86400000).toISOString()
        }
      }, token)
      extra.push(created.reminder)
    }

    miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
    await miniProgram.reLaunch('/pages/garden/garden')
    await miniProgram.navigateTo('/pages/plant-detail/plant-detail?id=' + plantId)
    const page = await miniProgram.currentPage()
    await page.waitFor(5000)
    await miniProgram.screenshot({ path: path.join(SHOT_DIR, PREFIX + '-list.png') })
    console.log('列表截图完成')

    // 提醒详情：头部也要跟着变色，挑 7 天前那条（正好是封顶色）
    if (byType.pruning) {
      await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + byType.pruning.id)
      await miniProgram.currentPage().then((p) => p.waitFor(4000))
      await miniProgram.screenshot({ path: path.join(SHOT_DIR, PREFIX + '-detail.png') })
      console.log('详情截图完成（修剪，逾期 7 天）')
    }
  } finally {
    if (miniProgram) await miniProgram.close().catch(() => {})
    db.close()
    await deletePlant(token, plantId).catch((err) => console.log('清理失败：' + err.message))
  }
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
