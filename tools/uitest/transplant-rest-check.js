// 校验"开始养护日期"与缓苗期口径：
// 1) 不填开始养护日期也能建档（选填）
// 2) 缓苗期从"加入档案那天"起算，和开始养护日期无关
// 3) AI 花农开场白 / 施肥方案 / 养护报告三处口径一致，不再自相矛盾
const { getToken, api, openDb } = require('./lib')

let failures = 0

function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (!ok) failures++
}

async function main() {
  const token = getToken()
  const db = openDb()
  const created = []

  try {
    // 场景 A：网购到手的小苗，不知道种下日期（不填开始养护日期），刚换盆
    const a = await api('/plants', {
      method: 'POST',
      body: {
        name: '缓苗口径A',
        species: '月季',
        growth_stage: '小苗',
        plant_source: '网购',
        is_recent_transplant: 1,
        exposure: 'outdoor',
        soil_id: 'peat_mix',
        soil_type: '通用营养土（泥炭混合）',
        pot_size: '3 加仑',
        pot_depth_mm: 235,
        pot_diameter_mm: 245
      }
    }, token)
    created.push(a.plant.id)
    check('不填开始养护日期也能建档', Boolean(a.plant.id), true)
    check('档案里开始养护日期为空', a.plant.planting_date, '')

    const aReminders = (await api('/plants/' + a.plant.id + '/reminders', {}, token)).reminders
    const aFert = aReminders.find((r) => r.type === 'fertilizing')
    const aFertDetail = (await api('/reminders/' + aFert.id, {}, token)).reminder
    const aDays = Math.round((new Date(aFert.due_at) - Date.now()) / 86400000)
    check('施肥提醒顺延到缓苗期结束', aDays >= 13 && aDays <= 14, true)
    check('施肥摘要说明缓苗期', /缓苗期/.test(aFert.summary_text), true)
    check('提醒 meta 记录了缓苗结束日', Boolean(aFertDetail.meta && aFertDetail.meta.rest_until), true)

    // rest_until 存的是本地日期，这里也按本地日期比较，避免时区差异造成误判
    const expectUntil = new Date(Date.now() + 14 * 86400000)
    const pad = (n) => (n < 10 ? '0' + n : '' + n)
    const expectStr = `${expectUntil.getFullYear()}-${pad(expectUntil.getMonth() + 1)}-${pad(expectUntil.getDate())}`
    check('缓苗结束日 = 建档日 + 14 天', String(aFertDetail.meta.rest_until), expectStr)
    check('结束日与摘要里的日期一致', aFert.summary_text.includes(expectUntil.getMonth() + 1 + ' 月 ' +
      expectUntil.getDate() + ' 日'), true)

    // 开场白口径
    const session = await api('/chat/gardener/session/' + a.plant.id, {}, token)
    const greeting = session.session.greeting
    console.log('开场白：' + greeting)
    check('开场白说明缓苗期并给出结束日', /缓苗期/.test(greeting) && /之后再施肥/.test(greeting), true)
    check('开场白不再编造"几个月几日种下"', !/种下/.test(greeting), true)

    // 场景 B：用户填了较早的开始养护日期 + 勾了刚移栽（过去会打架的情况）
    const old = new Date(Date.now() - 25 * 86400000).toISOString().slice(0, 10)
    const b = await api('/plants', {
      method: 'POST',
      body: {
        name: '缓苗口径B',
        species: '月季',
        growth_stage: '小苗',
        plant_source: '花市/花店',
        is_recent_transplant: 1,
        planting_date: old,
        exposure: 'open_balcony',
        soil_id: 'peat_mix',
        soil_type: '通用营养土（泥炭混合）',
        pot_size: '1 加仑',
        pot_depth_mm: 160,
        pot_diameter_mm: 175
      }
    }, token)
    created.push(b.plant.id)

    const bReminders = (await api('/plants/' + b.plant.id + '/reminders', {}, token)).reminders
    const bFert = bReminders.find((r) => r.type === 'fertilizing')
    const bDays = Math.round((new Date(bFert.due_at) - Date.now()) / 86400000)
    check('开始养护日期很早时，缓苗期仍从建档日算', bDays >= 13 && bDays <= 14, true)
    check('摘要仍提示缓苗期', /缓苗期/.test(bFert.summary_text), true)

    const bDetail = await api('/reminders/' + bFert.id + '/detail', {
      method: 'POST',
      body: { force: true, feedback: '' }
    }, token)
    const bText = String(bDetail.reminder.detail_content || '')
    console.log('施肥方案开头：' + bText.slice(0, 120))
    check('AI 方案与提醒口径一致（仍说缓苗期）', /缓苗期/.test(bText), true)
    check('AI 方案不再说"已经过了缓苗期可以施肥"', /已经过了缓苗期|刚好过了缓苗期/.test(bText), false)

    // 养护报告口径（没填开始养护日期的 A 也要有养护天数）
    const req = await api('/plants/' + a.plant.id + '/report', { method: 'POST', body: {} }, token)
    const requestId = req.request_id || req.requestId
    const deadline = Date.now() + 120000
    let report = null
    while (Date.now() < deadline) {
      const status = await api('/report-requests/' + requestId, {}, token)
      if (status.request && status.request.status === 'completed') { report = status.report; break }
      if (status.request && status.request.status === 'failed') throw new Error(status.request.error_info)
      await new Promise((r) => setTimeout(r, 3000))
    }
    if (!report) {
      check('养护报告生成成功', false, true)
    } else {
      console.log('报告时间范围：' + report.period_text)
      check('没填开始养护日期时按建档日起算', /至/.test(report.period_text), true)
      check('养护天数不为空', report.stats && report.stats.care_days !== null, true)
    }
  } finally {
    for (const id of created) await api('/plants/' + id, { method: 'DELETE' }, token).catch(() => {})
    const left = created.length
      ? db.prepare(`SELECT COUNT(*) AS c FROM plant_reminders WHERE plant_id IN (${created.join(',')})`).get().c
      : 0
    console.log('清理临时植物 ' + created.length + ' 盆，剩余提醒 ' + left + ' 条')
    if (left !== 0) failures++
    db.close()
  }

  console.log(failures === 0 ? '\n全部检查通过' : '\n' + failures + ' 项检查未通过')
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exitCode = 1
})
