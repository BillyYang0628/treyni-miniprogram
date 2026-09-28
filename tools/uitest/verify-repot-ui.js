// 第四期 UI：换盆提醒点「完成」应该走独立的确认面板，而不是普通的完成登记面板。
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
  const plantId = await createTempPlant(token, '换盆面板验证', '月季')
  const db = openDb()
  let miniProgram = null

  try {
    await new Promise((r) => setTimeout(r, 3000))
    const created = await api('/plants/' + plantId + '/reminders', {
      method: 'POST',
      body: {
        type: 'repot',
        title: '换盆',
        content: '给月季换个大一点的盆和新的土',
        due_at: new Date().toISOString()
      }
    }, token)
    const repot = created.reminder

    miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
    await miniProgram.reLaunch('/pages/garden/garden')
    await miniProgram.navigateTo('/pages/plant-detail/plant-detail?id=' + plantId)
    const page = await miniProgram.currentPage()
    await page.waitFor(5000)

    // 点换盆提醒的「完成」→ 应该开换盆面板，不是普通完成面板
    await page.callMethod('onCompleteReminder', { currentTarget: { dataset: { id: repot.id } } })
    await page.waitFor(1500)
    const opened = await page.data()
    check('换盆提醒打开了换盆面板', opened.repotShow, true)
    check('没有走普通的完成面板', opened.sheetShow, false)
    await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'repot-sheet.png') })
    console.log('  截图：repot-sheet.png')

    // 提交（选花盆 + 土壤）
    await page.callMethod('onRepotSubmit', {
      detail: { pot_size: '3 加仑', pot_depth_mm: 250, pot_diameter_mm: 220, soil_type: '通用营养土', soil_id: 'mixed_unknown' }
    })
    await page.waitFor(4000)

    const p = db.prepare('SELECT * FROM plants WHERE id = ?').get(plantId)
    check('花盆已更新', p.pot_size, '3 加仑')
    check('土壤已更新', p.soil_id, 'mixed_unknown')
    check('写了换盆日（触发缓苗期）', String(p.transplanted_at).slice(0, 10).length, 10)
    check('标记为刚换盆', Number(p.is_recent_transplant), 1)
    check('换盆提醒已完成',
      db.prepare('SELECT status FROM plant_reminders WHERE id = ?').get(repot.id).status, 'completed')
    check('面板关掉了', (await page.data()).repotShow, false)

    // 普通提醒仍然走完成登记面板（回归）
    const list = await api('/plants/' + plantId + '/reminders', {}, token)
    const fert = list.reminders.find((r) => r.type === 'fertilizing')
    await page.callMethod('onCompleteReminder', { currentTarget: { dataset: { id: fert.id } } })
    await page.waitFor(1200)
    const opened2 = await page.data()
    check('普通提醒还是走完成登记面板', opened2.sheetShow, true)
    check('普通提醒不会误开换盆面板', opened2.repotShow, false)
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
