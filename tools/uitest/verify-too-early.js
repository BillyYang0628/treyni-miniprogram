// 第三期：太早档二选一 + 改期。
// 面板内部节点选不到（automator 限制），所以：渲染看截图，动作直接调页面处理器。
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

function dayString(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000)
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

function localDay(iso) {
  const d = new Date(iso)
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const token = getToken()
  const plantId = await createTempPlant(token, '太早档验证', '月季')
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

    // 造一条"太早"的提醒：周期 10 天、到期还有 10 天 -> T=3 -> too_early
    db.prepare('UPDATE plant_reminders SET due_at = ?, interval_days = 10, meta_json = NULL WHERE id = ?')
      .run(new Date(Date.now() + 10 * 86400000).toISOString(), fert.id)

    const detail = await api('/reminders/' + fert.id, {}, token)
    console.log('档位：' + JSON.stringify(detail.reminder.timing))
    check('判定为 too_early', detail.reminder.timing.level, 'too_early')
    check('提前 10 天', detail.reminder.timing.early_days, 10)
    check('容忍 3 天', detail.reminder.timing.tolerance_days, 3)

    miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
    await miniProgram.reLaunch('/pages/garden/garden')
    await miniProgram.navigateTo('/pages/plant-detail/plant-detail?id=' + plantId)
    const page = await miniProgram.currentPage()
    await page.waitFor(5000)

    // 打开面板：应该是"已经做了 / 只是安排到那天"这一问
    await page.setData({ sheetShow: true, sheetReminder: detail.reminder })
    await page.waitFor(1500)
    await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'too-early-ask.png') })
    console.log('  截图：too-early-ask.png（应看到二选一）')

    // 选「只是安排到那天」→ 换个日子
    const target = dayString(3)
    await page.callMethod('onSheetReschedule', { detail: { due_at: target } })
    await page.waitFor(3000)

    const after = await api('/reminders/' + fert.id, {}, token)
    check('改期后日期变成目标日', localDay(after.reminder.due_at), target)
    check('改期不完成提醒（还是 pending）', after.reminder.status, 'pending')
    check('改期没有生成下一轮',
      db.prepare("SELECT COUNT(*) c FROM plant_reminders WHERE plant_id = ? AND status = 'pending'").get(plantId).c, 4)
    check('改期没有写养护历程',
      db.prepare('SELECT COUNT(*) c FROM plant_journal WHERE plant_id = ?').get(plantId).c, 0)
    check('面板关掉了', (await page.data()).sheetShow, false)

    // 改完之后档位应该跟着变（3 天后到期，T=3 -> early，不再是 too_early）
    console.log('改期后档位：' + after.reminder.timing.level)
    check('档位重新判定为 early', after.reminder.timing.level, 'early')
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
