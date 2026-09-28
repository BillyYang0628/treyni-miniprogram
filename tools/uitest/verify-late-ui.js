// 逾期原因题的界面：面板里应该出现"这段时间是什么情况"这一块。
// 面板内部节点选不到（automator 限制），所以渲染看截图、动作调页面处理器。
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

function dayString(offset) {
  const d = new Date(Date.now() + offset * 86400000)
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const token = getToken()
  const plantId = await createTempPlant(token, '逾期原因界面', '月季')
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

    // 造"逾期 6 天、间隔 10 天"→ 容忍 3 → too_late
    db.prepare('UPDATE plant_reminders SET due_at = ?, interval_days = 10, meta_json = NULL WHERE id = ?')
      .run(new Date(Date.now() - 6 * 86400000).toISOString(), fert.id)

    const detail = await api('/reminders/' + fert.id, {}, token)
    check('判定为 too_late', detail.reminder.timing.level, 'too_late')
    check('逾期 6 天', detail.reminder.timing.late_days, 6)
    check('容忍 3 天', detail.reminder.timing.late_tolerance_days, 3)

    miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
    await miniProgram.reLaunch('/pages/garden/garden')
    await miniProgram.navigateTo('/pages/plant-detail/plant-detail?id=' + plantId)
    const page = await miniProgram.currentPage()
    await page.waitFor(5000)

    await page.setData({ sheetShow: true, sheetReminder: detail.reminder })
    await page.waitFor(1500)
    check('面板打开了', (await page.data()).sheetShow, true)
    await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'late-ask.png') })
    console.log('  截图：late-ask.png（应看到"这段时间是什么情况"+ 5 个选项）')

    // 选「最近没顾上」提交
    await page.callMethod('onSheetSubmit', {
      detail: { occurred_at: dayString(0), done_items: ['按方案施的肥'], unsure: false, note: '', late_reason: 'forgot' }
    })
    await page.waitFor(3000)
    const after = await api('/reminders/' + fert.id, {}, token)
    check('提交后提醒已完成', after.reminder.status, 'completed')
    check('原因落库了', after.reminder.meta.completion.late_reason, 'forgot')
    const j = db.prepare('SELECT content FROM plant_journal WHERE plant_id = ? ORDER BY id DESC LIMIT 1').get(plantId)
    console.log('  养护历程：' + j.content)
    check('原因写进了养护历程', j.content.indexOf('最近没顾上') >= 0, true)
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
