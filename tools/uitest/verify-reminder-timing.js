// 第三期：阈值表 + 冻结 + 改期。
// 纯函数和 SQL 的验证，不用开发者工具。
const path = require('node:path')
const { getToken, api, createTempPlant, deletePlant, openDb, BASE } = require('./lib')
const timing = require(path.resolve(__dirname, '../../server/src/services/reminderTiming.js'))

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (!ok) failures++
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
  console.log('=== 提前容忍 T（对照《每日提醒阈值方案.md》第二节）===')
  // 浇水固定 1 天，不参与缩放
  check('浇水 周期 2 天', timing.toleranceDays('watering', 2, {}), 1)
  check('浇水 周期 10 天', timing.toleranceDays('watering', 10, {}), 1)

  // 施肥 25%，夹 [2,5]
  check('施肥 7 天', timing.toleranceDays('fertilizing', 7, {}), 2)
  check('施肥 10 天（文档写 2，按公式应为 3）', timing.toleranceDays('fertilizing', 10, {}), 3)
  check('施肥 15 天', timing.toleranceDays('fertilizing', 15, {}), 4)
  check('施肥 30 天（夹到上限 5）', timing.toleranceDays('fertilizing', 30, {}), 5)

  // 打药 20%，夹 [2,3]
  check('打药 10 天', timing.toleranceDays('pesticide', 10, {}), 2)
  check('打药 15 天', timing.toleranceDays('pesticide', 15, {}), 3)
  check('打药 20 天（夹到上限 3）', timing.toleranceDays('pesticide', 20, {}), 3)

  // 修剪 25%，夹 [3,10]
  check('修剪 7 天（夹到下限 3）', timing.toleranceDays('pruning', 7, {}), 3)
  check('修剪 30 天', timing.toleranceDays('pruning', 30, {}), 8)
  check('修剪 40 天', timing.toleranceDays('pruning', 40, {}), 10)
  check('修剪 90 天（夹到上限 10）', timing.toleranceDays('pruning', 90, {}), 10)

  // 三条特殊规则
  check('诊断疗程用药强制 1 天', timing.toleranceDays('pesticide', 20, { treatment_cycle_id: 7 }), 1)
  check('缓苗期施肥不做太早判定', timing.toleranceDays('fertilizing', 15, { rest: 'transplant' }), null)
  check('自定义提醒不做太早判定', timing.toleranceDays('custom', 3, {}), null)

  console.log('')
  console.log('=== 逾期容忍（25%，夹 [1,7]）===')
  check('周期 2 天', timing.lateToleranceDays(2), 1)
  check('周期 15 天', timing.lateToleranceDays(15), 4)
  check('周期 30 天（夹到上限 7）', timing.lateToleranceDays(30), 7)

  const token = getToken()
  const plantId = await createTempPlant(token, '阈值验证', '月季')
  const db = openDb()

  try {
    let list = null
    for (let i = 0; i < 20; i++) {
      list = await api('/plants/' + plantId + '/reminders', {}, token)
      if ((list.reminders || []).length >= 4) break
      await new Promise((r) => setTimeout(r, 1000))
    }

    const fert = list.reminders.find((r) => r.type === 'fertilizing')
    console.log('')
    console.log('=== 提醒上带的档位 ===')
    console.log('  施肥提醒 timing：' + JSON.stringify(fert.timing))
    check('列表里带上了 timing', Boolean(fert.timing), true)
    check('生成时就冻结了', fert.timing && fert.timing.frozen, true)

    const frozenT = fert.timing.tolerance_days
    check('冻结点跟阈值表一致', frozenT, timing.toleranceDays('fertilizing', fert.interval_days, {}))

    // 冻结的意义：间隔被改掉，T 也不跟着变
    db.prepare('UPDATE plant_reminders SET interval_days = 90 WHERE id = ?').run(fert.id)
    const after = await api('/reminders/' + fert.id, {}, token)
    check('间隔从 ' + fert.interval_days + ' 改成 90 之后，T 保持不变',
      after.reminder.timing.tolerance_days, frozenT)
    check('逾期容忍也保持冻结值',
      after.reminder.timing.late_tolerance_days, fert.timing.late_tolerance_days)

    // 懒回填：老数据（没有 meta.timing）读一次就该被补上
    db.prepare("UPDATE plant_reminders SET meta_json = NULL WHERE id = ?").run(fert.id)
    const back = await api('/reminders/' + fert.id, {}, token)
    check('没冻结时会被懒回填', back.reminder.timing && back.reminder.timing.frozen, true)
    const row = db.prepare('SELECT meta_json FROM plant_reminders WHERE id = ?').get(fert.id)
    check('确实写进了 meta_json', JSON.parse(row.meta_json).timing ? true : false, true)

    console.log('')
    console.log('=== 改期 ===')
    const target = dayString(5)
    const res = await fetch(BASE + '/reminders/' + fert.id + '/reschedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ due_at: target })
    })
    const resData = await res.json()
    check('改期接口返回 200', res.status, 200)
    check('日期改成目标日', localDay(resData.reminder.due_at), target)
    check('状态还是 pending（没被完成）', resData.reminder.status, 'pending')

    const bad = await fetch(BASE + '/reminders/' + fert.id + '/reschedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ due_at: '不是日期' })
    })
    check('非法日期被拒', bad.status, 400)

    console.log('')
    console.log('=== 档位判定 ===')
    // 把施肥改成 10 天后到期，T=3 -> 属于"略早"
    db.prepare('UPDATE plant_reminders SET due_at = ?, interval_days = 10 WHERE id = ?')
      .run(new Date(Date.now() + 10 * 86400000).toISOString(), fert.id)
    db.prepare('UPDATE plant_reminders SET meta_json = NULL WHERE id = ?').run(fert.id)
    let r = await api('/reminders/' + fert.id, {}, token)
    check('提前 10 天、T=3 -> too_early', r.reminder.timing.level, 'too_early')
    check('提前天数算对了', r.reminder.timing.early_days, 10)

    db.prepare('UPDATE plant_reminders SET due_at = ?, interval_days = 10 WHERE id = ?')
      .run(new Date(Date.now() + 2 * 86400000).toISOString(), fert.id)
    db.prepare('UPDATE plant_reminders SET meta_json = NULL WHERE id = ?').run(fert.id)
    r = await api('/reminders/' + fert.id, {}, token)
    check('提前 2 天、T=3 -> early', r.reminder.timing.level, 'early')

    db.prepare('UPDATE plant_reminders SET due_at = ?, interval_days = 10 WHERE id = ?')
      .run(new Date(Date.now() + 3600000).toISOString(), fert.id)
    db.prepare('UPDATE plant_reminders SET meta_json = NULL WHERE id = ?').run(fert.id)
    r = await api('/reminders/' + fert.id, {}, token)
    check('今天到期 -> ok', r.reminder.timing.level, 'ok')

    db.prepare('UPDATE plant_reminders SET due_at = ?, interval_days = 10 WHERE id = ?')
      .run(new Date(Date.now() - 3 * 86400000).toISOString(), fert.id)
    db.prepare('UPDATE plant_reminders SET meta_json = NULL WHERE id = ?').run(fert.id)
    r = await api('/reminders/' + fert.id, {}, token)
    check('逾期 3 天、容忍 3 -> late', r.reminder.timing.level, 'late')

    db.prepare('UPDATE plant_reminders SET due_at = ?, interval_days = 10 WHERE id = ?')
      .run(new Date(Date.now() - 6 * 86400000).toISOString(), fert.id)
    db.prepare('UPDATE plant_reminders SET meta_json = NULL WHERE id = ?').run(fert.id)
    r = await api('/reminders/' + fert.id, {}, token)
    check('逾期 6 天、容忍 3 -> too_late', r.reminder.timing.level, 'too_late')
  } finally {
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
