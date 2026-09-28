// 验证第二期：实际完成日期驱动下一轮 + 不能落在过去的护栏 + 撤销整行回滚。
const { getToken, api, createTempPlant, deletePlant, openDb, BASE } = require('./lib')

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

/** 取 ISO 时间在**本地时区**的那一天。直接 slice(0,10) 拿到的是 UTC 日期，会差一天 */
function localDay(iso) {
  const d = new Date(iso)
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

/** 目标日期距今还有几天（负数=已经过去） */
function daysFromToday(iso, today) {
  const a = new Date(iso + 'T00:00:00+08:00')
  const b = new Date(today + 'T00:00:00+08:00')
  return Math.round((a - b) / 86400000)
}

async function complete(token, id, body) {
  const res = await fetch(BASE + '/reminders/' + id + '/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body || {})
  })
  return { status: res.status, data: await res.json() }
}

async function main() {
  const token = getToken()
  const plantId = await createTempPlant(token, '实际日期验证', '月季')
  const db = openDb()

  try {
    let list = null
    for (let i = 0; i < 20; i++) {
      list = await api('/plants/' + plantId + '/reminders', {}, token)
      if ((list.reminders || []).length >= 4) break
      await new Promise((r) => setTimeout(r, 1000))
    }
    const fertilizing = list.reminders.find((r) => r.type === 'fertilizing')
    const interval = fertilizing.interval_days
    console.log('施肥提醒：id=' + fertilizing.id + ' 间隔=' + interval + ' 天（缓苗期会顺延，这里看间隔本身）')

    // ---- 1) 按实际日期算下一轮 ----
    const occurred = dayString(-3)
    const r1 = await complete(token, fertilizing.id, { occurred_at: occurred, done_items: ['按方案施的肥'] })
    check('完成接口返回 200', r1.status, 200)
    check('回传了实际日期', r1.data.occurred_at, occurred)
    check('回传了撤销凭据', Boolean(r1.data.undo_token), true)
    check('撤销窗口 5 秒', r1.data.undo_seconds, 5)

    const next = r1.data.next_reminder
    const gap = daysFromToday(localDay(next.due_at), dayString(0))
    console.log('  下一轮到期：' + localDay(next.due_at) + '（距今 ' + gap + ' 天）')
    // 按"实际日期 + 间隔"：3 天前 + 间隔；比"今天 + 间隔"少 3 天
    check('下一轮按实际日期起算（比"今天+间隔"少 3 天）', gap, Number(next.interval_days) - 3)

    // ---- 2) 撤销：整行回滚 ----
    const undo = await fetch(BASE + '/reminders/' + fertilizing.id + '/undo-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ token: r1.data.undo_token })
    })
    const undoData = await undo.json()
    check('撤销接口返回 200', undo.status, 200)
    check('撤销后提醒回到 pending', undoData.reminder.status, 'pending')
    check('撤销后 completed_at 清空', undoData.reminder.completed_at || '', '')
    check('撤销后 meta.completion 清掉', Boolean(undoData.reminder.meta && undoData.reminder.meta.completion), false)
    check('刚生成的下一轮被删掉',
      db.prepare('SELECT COUNT(*) c FROM plant_reminders WHERE id = ?').get(next.id).c, 0)
    check('养护历程那条被删掉',
      db.prepare("SELECT COUNT(*) c FROM plant_journal WHERE plant_id = ? AND content LIKE '%完成提醒%'").get(plantId).c, 0)

    // 同一个凭据不能撤两次
    const undo2 = await fetch(BASE + '/reminders/' + fertilizing.id + '/undo-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ token: r1.data.undo_token })
    })
    check('同一凭据不能撤两次', undo2.status, 410)

    // ---- 3) 护栏：算出来落在过去时退回"今天 + 间隔" ----
    const custom = await api('/plants/' + plantId + '/reminders', {
      method: 'POST',
      body: { type: 'custom', title: '护栏测试', content: 'x', interval_days: 3, due_at: dayString(1) }
    }, token)
    const r2 = await complete(token, custom.reminder.id, { occurred_at: dayString(-10) })
    const n2 = r2.data.next_reminder
    const gap2 = daysFromToday(localDay(n2.due_at), dayString(0))
    console.log('  补录 10 天前、间隔 3 天 -> 下一轮距今 ' + gap2 + ' 天')
    check('护栏生效：退回"今天 + 间隔"', gap2, 3)

    // ---- 4) 浇水：下一轮应落在「实际浇水日 + 间隔」而不是"今天 + 间隔" ----
    const watering = list.reminders.find((r) => r.type === 'watering')
    if (watering) {
      const r3 = await complete(token, watering.id, { occurred_at: dayString(-1), done_items: ['浇透了'] })
      const n3 = r3.data.next_reminder
      if (n3) {
        // 浇水的水分数值是后台异步算的（要调天气接口），等它写出来
        let w = null
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 1000))
          const probe = await api('/reminders/' + n3.id, {}, token)
          w = probe.reminder.meta && probe.reminder.meta.water
          if (w && w.baseline) break
        }
        const gap3 = daysFromToday(localDay(n3.due_at), dayString(0))
        console.log('  浇水（昨天浇的）-> 下一轮距今 ' + gap3 + ' 天，间隔 ' + n3.interval_days)
        check('浇水基准按实际日期写的', Boolean(w && w.baseline && w.baseline.date), true)
        check('基准日期 = 实际浇水日', w && w.baseline && w.baseline.date, dayString(-1))
      }
    }
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
