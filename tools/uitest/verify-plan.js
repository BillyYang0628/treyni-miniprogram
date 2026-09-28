// 「计划一件事」：四类以内 / 换盆 / 四类以外的区分 + 关键词检测。
const path = require('node:path')
const { getToken, api, createTempPlant, deletePlant, openDb, BASE } = require('./lib')
const planService = require(path.resolve(__dirname, '../../server/src/services/plan.js'))

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

async function postPlan(token, plantId, body) {
  const res = await fetch(BASE + '/plants/' + plantId + '/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body)
  })
  return { status: res.status, data: await res.json() }
}

async function main() {
  console.log('=== 关键词识别（唯一出处，前端不复制）===')
  check('下周末给月季换个盆 -> 换盆', (planService.detectCareKind('下周末给月季换个盆') || {}).kind, 'repot')
  check('买点花多多施肥 -> 施肥', (planService.detectCareKind('买点花多多施肥') || {}).kind, 'fertilizing')
  check('打一次杀虫药 -> 打药', (planService.detectCareKind('打一次杀虫药') || {}).kind, 'pesticide')
  check('把枯枝剪掉 -> 修剪', (planService.detectCareKind('把枯枝剪掉') || {}).kind, 'pruning')
  check('该浇透了 -> 浇水', (planService.detectCareKind('该浇透了') || {}).kind, 'watering')
  check('买个补光灯 -> 认不出来', planService.detectCareKind('买个补光灯'), null)
  check('换个位置摆 -> 认不出来（不是换盆）', planService.detectCareKind('换个位置摆到窗边'), null)

  const token = getToken()
  const plantId = await createTempPlant(token, '计划验证', '月季')
  const db = openDb()

  try {
    let list = null
    for (let i = 0; i < 20; i++) {
      list = await api('/plants/' + plantId + '/reminders', {}, token)
      if ((list.reminders || []).length >= 4) break
      await new Promise((r) => setTimeout(r, 1000))
    }
    const watering = list.reminders.find((r) => r.type === 'watering')

    console.log('')
    console.log('=== 四类以内：改的是提醒 ===')
    const target = dayString(6)
    const r1 = await postPlan(token, plantId, { kind: 'watering', due_at: target, title: '周六早上浇水' })
    check('返回 201', r1.status, 201)
    check('落到提醒上了', r1.data.affects_reminders, true)
    const w = await api('/reminders/' + watering.id, {}, token)
    check('浇水提醒的日期被改了', localDay(w.reminder.due_at), target)
    check('提醒仍是待办（没有完成）', w.reminder.status, 'pending')
    check('养护历程记了一条计划',
      db.prepare("SELECT COUNT(*) c FROM plant_journal WHERE plant_id = ? AND kind = 'planned'").get(plantId).c, 1)

    console.log('')
    console.log('=== 换盆：没有提醒就建一条 ===')
    const r2 = await postPlan(token, plantId, { kind: 'repot', due_at: dayString(3), title: '换个大盆' })
    check('返回 201', r2.status, 201)
    check('新建了换盆提醒', r2.data.reminder_created, true)
    check('换盆提醒的日期是目标日', localDay(r2.data.reminder.due_at), dayString(3))

    console.log('')
    console.log('=== 四类以外：不碰提醒 ===')
    const remindersBefore = db
      .prepare("SELECT COUNT(*) c FROM plant_reminders WHERE plant_id = ? AND status = 'pending'").get(plantId).c
    const r3 = await postPlan(token, plantId, { kind: 'other', due_at: dayString(2), title: '买个补光灯' })
    check('返回 201', r3.status, 201)
    check('不影响提醒', r3.data.affects_reminders, false)
    check('提醒数量没变',
      db.prepare("SELECT COUNT(*) c FROM plant_reminders WHERE plant_id = ? AND status = 'pending'").get(plantId).c,
      remindersBefore)
    check('写了计划记录', r3.data.journal.kind, 'planned')
    check('计划记录带上了日期', r3.data.journal.occurred_at, dayString(2))

    console.log('')
    console.log('=== 关键词检测：四类以外的内容里出现四类关键词 ===')
    const r4 = await postPlan(token, plantId, { kind: 'other', due_at: dayString(4), title: '给月季换个盆' })
    check('先不保存，要求确认', r4.data.need_confirm, true)
    check('识别成换盆', (r4.data.suggestion || {}).kind, 'repot')
    console.log('  提示文案：' + r4.data.message)
    const plannedBefore = db
      .prepare("SELECT COUNT(*) c FROM plant_journal WHERE plant_id = ? AND kind = 'planned'").get(plantId).c
    check('确认前没有落库',
      db.prepare("SELECT COUNT(*) c FROM plant_journal WHERE plant_id = ? AND kind = 'planned'").get(plantId).c,
      plannedBefore)

    // 用户选「不用」→ 按普通计划存下来
    const r5 = await postPlan(token, plantId, { kind: 'other', due_at: dayString(4), title: '给月季换个盆', accept_keyword: true })
    check('选「不用」之后存成了普通计划', r5.data.plan_kind, 'other')

    console.log('')
    console.log('=== 参数校验 ===')
    const bad1 = await postPlan(token, plantId, { kind: 'watering', due_at: '明天' })
    check('日期格式不对被拒', bad1.status, 400)
    const bad2 = await postPlan(token, plantId, { kind: '乱写的', due_at: dayString(1) })
    check('未知类型被拒', bad2.status, 400)
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
