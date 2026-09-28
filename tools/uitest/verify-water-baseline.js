// 验证「土壤水分基准」这一版（对应 有待解决的问题.txt 第 2 组）：
//   1) 新的浇水提醒没有基准 → 页面应该提示先确认，而不是拿默认值糊弄
//   2) 用户确认「已经干透」→ 水分账户应该掉到 10% 左右，下次浇水日期提前
//   3) 用户确认「刚浇过水」→ 账户回到 100%，下次浇水日期推后
//   4) 「重新生成这份方案」里填「现在土壤是刚浇过水的状态」也要能改到水分
//   5) AI 花农里说「土还是湿的」也要能改到水分
// 全程用临时植物，跑完删掉。
const { getToken, api, createTempPlant, deletePlant, BASE } = require('./lib')

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (!ok) failures++
  return ok
}

async function main() {
  const token = getToken()
  const plantId = await createTempPlant(token, '水基准验证', '月季')

  try {
    const list = await api('/plants/' + plantId + '/reminders', {}, token)
    const watering = list.reminders.find((r) => r.type === 'watering')
    if (!watering) throw new Error('临时植物没有浇水提醒')

    // 建植物时水分模型是在后台跑的，等它把 meta.water 写出来
    let waited = 0
    while (waited < 60000) {
      const probe = await api('/reminders/' + watering.id, {}, token)
      if (probe.reminder.water) break
      await new Promise((resolve) => setTimeout(resolve, 2000))
      waited += 2000
    }

    // ---- 1) 初始状态：没有基准 ----
    let detail = await api('/reminders/' + watering.id, {}, token)
    console.log('初始 water: ' + JSON.stringify(detail.reminder.water && {
      tank: detail.reminder.water.tank_percent,
      due: detail.reminder.water.next_due_date,
      baseline: detail.reminder.water.baseline || null
    }))
    check('新提醒还没有用户确认的基准',
      Boolean(detail.reminder.water && detail.reminder.water.baseline), false)
    const tankBefore = detail.reminder.water.tank_percent
    const dueBefore = detail.reminder.water.next_due_date

    // ---- 2) 确认「已经干透」 ----
    let res = await api('/reminders/' + watering.id + '/water-baseline',
      { method: 'POST', body: { level: 'dry' } }, token)
    console.log('干透后 water: ' + JSON.stringify({
      tank: res.reminder.water.tank_percent,
      due: res.reminder.water.next_due_date,
      baseline: res.reminder.water.baseline.label
    }))
    check('基准记成了「已经干透」', res.reminder.water.baseline.label, '已经干透')
    check('水分账户掉到 10%', res.reminder.water.tank_percent, 10)
    check('这次数字来自基准', res.reminder.water.from_baseline, true)
    check('账户确实变了（和默认值不同）', res.reminder.water.tank_percent !== tankBefore, true)
    const dueDry = res.reminder.water.next_due_date

    // ---- 3) 改成「刚浇过水」 ----
    res = await api('/reminders/' + watering.id + '/water-baseline',
      { method: 'POST', body: { level: 'soaked' } }, token)
    console.log('刚浇过水后 water: ' + JSON.stringify({
      tank: res.reminder.water.tank_percent,
      due: res.reminder.water.next_due_date
    }))
    check('水分账户回到 100%', res.reminder.water.tank_percent, 100)
    check('下次浇水日期比"干透"时更晚', res.reminder.water.next_due_date > dueDry, true)
    // 原来是 `!== dueBefore`，但这条断言在"每天消耗很大"的时候会假失败：
    // 新提醒默认 tank=50%、刚浇过水是 100%，两者算出来可能落在同一个日历日
    // （实测 2026-09-20：默认 09-22、刚浇过水 09-22、干透 09-21）。
    // 真正要守的是"基准生效后日期不会比默认更早"，不等于要求日期必须变化——
    // 上面「账户回到 100%」那条已经在验效果了。
    check('不比默认的日期更早', res.reminder.water.next_due_date >= dueBefore, true)

    // ---- 4) 「重新生成这份方案」的反馈也要能改水分 ----
    // 先退回干透，再用反馈把它改回"刚浇过水"，看反馈是不是真的生效
    await api('/reminders/' + watering.id + '/water-baseline',
      { method: 'POST', body: { level: 'dry' } }, token)

    const detailRes = await fetch(BASE + '/reminders/' + watering.id + '/detail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ force: true, feedback: '现在土壤是刚浇过水的状态' })
    })
    console.log('重新生成接口返回: ' + detailRes.status)

    detail = await api('/reminders/' + watering.id, {}, token)
    check('反馈里的"刚浇过水"改到了水分基准',
      detail.reminder.water.baseline.label, '刚浇过水')
    check('水分账户随之回到 100%', detail.reminder.water.tank_percent, 100)

    // ---- 5) AI 花农里描述土壤状态 ----
    await api('/reminders/' + watering.id + '/water-baseline',
      { method: 'POST', body: { level: 'soaked' } }, token)

    const chatRes = await fetch(BASE + '/chat/gardener', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ plant_id: plantId, message: '土已经干透了，表面都裂了' })
    })
    const chatData = await chatRes.json()
    console.log('对话返回 water_note: ' + (chatData.water_note || '(空)'))
    check('对话里说的土壤状态被识别', Boolean(chatData.water_note), true)

    detail = await api('/reminders/' + watering.id, {}, token)
    check('水分基准被对话改成「已经干透」',
      detail.reminder.water.baseline.label, '已经干透')
    check('水分账户跟着掉到 10%', detail.reminder.water.tank_percent, 10)
  } finally {
    await deletePlant(token, plantId).catch((err) => console.log('清理失败：' + err.message))
  }

  console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项未通过')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
