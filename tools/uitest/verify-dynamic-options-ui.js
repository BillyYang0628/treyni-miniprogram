// 第五期 UI：完成面板优先用「方案级 + 物种级」候选，并用方案自带的实时问题。
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { getToken, api, createTempPlant, deletePlant, openDb } = require('./lib')

const SHOT_DIR = path.resolve(__dirname, 'shots-art')

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (!ok) failures++
  return ok
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const token = getToken()
  const plantId = await createTempPlant(token, '动态候选验证', '月季')
  const db = openDb()
  let miniProgram = null

  try {
    let list = null
    for (let i = 0; i < 20; i++) {
      list = await api('/plants/' + plantId + '/reminders', {}, token)
      if ((list.reminders || []).length >= 4) break
      await new Promise((r) => setTimeout(r, 1000))
    }
    const fert = list.reminders.find((r) => r.type === 'fertilizing')

    // 方案级候选 + 实时问题（模拟"生成方案时 AI 一起产出的"）
    db.prepare('UPDATE plant_reminders SET options_json = ? WHERE id = ?').run(
      JSON.stringify({ options: ['换了别的牌子的肥', '按说明稀释'], ask: '这次是按说明配的浓度吗？' }),
      fert.id
    )
    // 把到期日设成今天：否则这条还在 7 天后，面板会先进"太早档"的二选一，
    // 看不到"这次怎么做的"那一块（第一版截图就拍成了太早档）
    db.prepare('UPDATE plant_reminders SET due_at = ?, meta_json = NULL WHERE id = ?')
      .run(new Date().toISOString(), fert.id)
    // 物种级候选（另一个来源）
    db.prepare(`
      INSERT INTO species_care_options (species, options_json, ai_model, updated_at)
      VALUES ('月季', ?, 'ai', ?)
      ON CONFLICT(species) DO UPDATE SET options_json = excluded.options_json
    `).run(JSON.stringify({ fertilizing: ['花多多1号', '奥绿A2'], pesticide: ['苯甲·吡唑酯'], pruning: [] }), new Date().toISOString())

    const detail = await api('/reminders/' + fert.id, {}, token)
    console.log('方案级 options：' + JSON.stringify(detail.reminder.options) + '  ask：' + detail.reminder.ask)
    console.log('物种级 care_options：' + JSON.stringify(detail.reminder.care_options))
    check('接口同时带上了两层候选', detail.reminder.options.length === 2 && detail.reminder.care_options.length === 2, true)

    miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
    await miniProgram.reLaunch('/pages/garden/garden')
    await miniProgram.navigateTo('/pages/plant-detail/plant-detail?id=' + plantId)
    const page = await miniProgram.currentPage()
    await page.waitFor(5000)

    // 从列表里的那条提醒打开面板（列表也要带上两层候选）
    const rowData = (await page.data()).reminders.find((r) => r.type === 'fertilizing')
    console.log('列表里的 care_options：' + JSON.stringify(rowData.care_options))
    check('列表也带上了物种级候选', (rowData.care_options || [])[0], '花多多1号')

    await page.setData({ sheetShow: true, sheetReminder: detail.reminder })
    await page.waitFor(1500)
    await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'dynamic-options.png') })
    console.log('  截图：dynamic-options.png（应看到"这次是按说明配的浓度吗？"+ 动态候选）')
    check('面板打开了', (await page.data()).sheetShow, true)

    // 候选预算（2026-09-21 放宽）：动态最多 4 个，这里 2 方案级 + 2 物种级 → 全上，
    // 再加固定的「用了别的」「说不清」共 6 格。
    // automator 选不到组件内部节点，所以走 selectComponent + data 读组件状态。
    const sheetOptions = await miniProgram.evaluate(function () {
      const pages = getCurrentPages()
      const comp = pages[pages.length - 1].selectComponent('#completeSheet')
      return comp ? comp.data.options.map(function (item) { return item.label }) : null
    })
    console.log('  面板候选：' + JSON.stringify(sheetOptions))
    check('方案级 2 + 物种级 2 全部上屏（动态 4 + 固定 2）',
      (sheetOptions || []).length, 6)
    check('除「用了别的」外还剩 5 格（4 动态 + 说不清）',
      (sheetOptions || []).filter(function (label) {
        return label.indexOf('用了别的') !== 0
      }).length, 5)
  } finally {
    if (miniProgram) await miniProgram.close().catch(() => {})
    db.close()
    await deletePlant(token, plantId).catch((err) => console.log('清理失败：' + err.message))
  }

  console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项未通过')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
