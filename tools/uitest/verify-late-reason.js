// 逾期原因题：档位判定 + 五种原因各自的处理。
const { getToken, api, createTempPlant, deletePlant, openDb, BASE } = require('./lib')

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

function localDay(iso) {
  const d = new Date(iso)
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

async function complete(token, id, body) {
  const res = await fetch(BASE + '/reminders/' + id + '/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body || {})
  })
  return { status: res.status, data: await res.json() }
}

/** 造一条逾期 N 天的施肥提醒（间隔 10 天 → 逾期容忍 4 天） */
function makeLate(db, reminderId, days) {
  db.prepare('UPDATE plant_reminders SET due_at = ?, interval_days = 10, meta_json = NULL WHERE id = ?')
    .run(new Date(Date.now() - days * 86400000).toISOString(), reminderId)
}

async function main() {
  const token = getToken()
  const plantId = await createTempPlant(token, '逾期原因验证', '月季')
  const db = openDb()

  try {
    let list = null
    for (let i = 0; i < 20; i++) {
      list = await api('/plants/' + plantId + '/reminders', {}, token)
      if ((list.reminders || []).length >= 4) break
      await new Promise((r) => setTimeout(r, 1000))
    }
    const fert = list.reminders.find((r) => r.type === 'fertilizing')
    const prune = list.reminders.find((r) => r.type === 'pruning')
    const water = list.reminders.find((r) => r.type === 'watering')

    console.log('=== 档位判定 ===')
    makeLate(db, fert.id, 2)
    let r = await api('/reminders/' + fert.id, {}, token)
    check('逾期 2 天（容忍 4）-> late，不该问题', r.reminder.timing.level, 'late')
    makeLate(db, fert.id, 6)
    r = await api('/reminders/' + fert.id, {}, token)
    check('逾期 6 天（容忍 4）-> too_late，要问原因', r.reminder.timing.level, 'too_late')
    check('逾期天数算对了', r.reminder.timing.late_days, 6)
    // 施肥间隔 10 天：round(10 × 25%) = round(2.5) = 3（文档示例里的 4 对应的是 15 天）
    check('逾期容忍是 3 天', r.reminder.timing.late_tolerance_days, 3)

    console.log('')
    console.log('=== 「最近没顾上」：正常完成，原因写进养护历程 ===')
    makeLate(db, fert.id, 6)
    let res = await complete(token, fert.id, { occurred_at: dayString(0), done_items: ['按方案施的肥'], late_reason: 'forgot' })
    check('完成成功', res.status, 200)
    check('状态是 completed', (await api('/reminders/' + fert.id, {}, token)).reminder.status, 'completed')
    let j = db.prepare('SELECT content FROM plant_journal WHERE plant_id = ? ORDER BY id DESC LIMIT 1').get(plantId)
    console.log('  养护历程：' + j.content)
    check('原因写进了养护历程', j.content.indexOf('最近没顾上') >= 0, true)

    console.log('')
    console.log('=== 「其实已经做过了」：标 skipped、不写养护历程、不记浇水事件 ===')
    makeLate(db, water.id, 6)
    const journalBefore = db.prepare('SELECT COUNT(*) c FROM plant_journal WHERE plant_id = ?').get(plantId).c
    const eventBefore = db.prepare('SELECT COUNT(*) c FROM plant_water_events WHERE plant_id = ?').get(plantId).c
    res = await complete(token, water.id, { occurred_at: dayString(0), late_reason: 'already_done' })
    check('接口返回 skipped 标记', res.data.skipped, true)
    check('提醒状态是 skipped',
      db.prepare('SELECT status FROM plant_reminders WHERE id = ?').get(water.id).status, 'skipped')
    check('没有写养护历程',
      db.prepare('SELECT COUNT(*) c FROM plant_journal WHERE plant_id = ?').get(plantId).c, journalBefore)
    check('没有记浇水事件',
      db.prepare('SELECT COUNT(*) c FROM plant_water_events WHERE plant_id = ?').get(plantId).c, eventBefore)
    check('但下一轮照常排（周期要继续）', Boolean(res.data.next_reminder), true)

    console.log('')
    console.log('=== 「天气不合适」：正常完成 + 记录原因 ===')
    makeLate(db, prune.id, 20)
    res = await complete(token, prune.id, { occurred_at: dayString(0), done_items: ['剪了枯枝病叶'], late_reason: 'weather', late_note: '这段时间一直下雨' })
    check('完成成功', res.status, 200)
    j = db.prepare('SELECT content FROM plant_journal WHERE plant_id = ? ORDER BY id DESC LIMIT 1').get(plantId)
    console.log('  养护历程：' + j.content)
    check('原因带上去了', j.content.indexOf('天气不合适') >= 0, true)

    console.log('')
    console.log('=== 「这段时间不需要做」+ 拉长间隔 ===')
    // 重新造一条施肥提醒来测
    const created = await api('/plants/' + plantId + '/reminders', {
      method: 'POST',
      body: { type: 'fertilizing', title: '施肥', content: 'x', interval_days: 10, due_at: new Date(Date.now() - 6 * 86400000).toISOString() }
    }, token)
    const before = Number(created.reminder.interval_days)
    res = await complete(token, created.reminder.id, { occurred_at: dayString(0), late_reason: 'not_needed', extend_interval: true })
    const next = res.data.next_reminder
    console.log('  原间隔 ' + before + ' -> 新间隔 ' + next.interval_days)
    check('间隔翻倍了', Number(next.interval_days), before * 2)
    check('下一轮按新间隔排', localDay(next.due_at), dayString(before * 2))

    console.log('')
    console.log('=== 「其他原因」：自由文本带上 ===')
    const created2 = await api('/plants/' + plantId + '/reminders', {
      method: 'POST',
      body: { type: 'pesticide', title: '打药', content: 'x', interval_days: 10, due_at: new Date(Date.now() - 6 * 86400000).toISOString() }
    }, token)
    res = await complete(token, created2.reminder.id, { occurred_at: dayString(0), late_reason: 'other', late_note: '花盆搬到外婆家忘带回来了' })
    check('完成成功', res.status, 200)
    j = db.prepare('SELECT content FROM plant_journal WHERE plant_id = ? ORDER BY id DESC LIMIT 1').get(plantId)
    console.log('  养护历程：' + j.content)
    check('自由文本带上了', j.content.indexOf('外婆家') >= 0, true)

    console.log('')
    console.log('=== 逾期原因的元数据 ===')
    const meta = (await api('/reminders/' + fert.id, {}, token)).reminder.meta.completion
    console.log('  ' + JSON.stringify(meta))
    check('late_reason 落库了', meta.late_reason, 'forgot')
    check('skipped 标记正确', meta.skipped, false)
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
