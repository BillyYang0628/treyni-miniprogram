// 校验：
// 1) 天气模型与知识库差得不多时，完全采用天气模型；
// 2) 差得太多时，按 0.7×天气模型 + 0.3×知识库 折中，结果更偏向天气模型；
// 3) 刚换盆/刚移栽的植物，施肥提醒顺延到缓苗期结束并写清原因。
const { getToken, api, openDb } = require('./lib')
const waterModel = require('../../server/src/services/waterModel')

let failures = 0

function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (!ok) failures++
}

function daily(et0) {
  const list = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() + i * 86400000)
    list.push({
      date: waterModel.formatDate(d),
      et0,
      tmax: 30,
      tmin: 20,
      humidity: 60,
      rainMm: 0
    })
  }
  return list
}

function project({ i0, baseIntervalDays, et0 }) {
  return waterModel.projectWatering({
    daily: daily(et0),
    i0,
    baseIntervalDays,
    indoor: false,
    substrateW: 0.3,
    awcMm: 70,
    rainFactor: 0.6,
    latitude: 31.23,
    today: waterModel.formatDate(new Date())
  })
}

async function main() {
  const token = getToken()
  const db = openDb()
  let plantId = null

  try {
    console.log('--- 1. 差得不多：完全采用天气模型 ---')
    const near = project({ i0: 2.53, baseIntervalDays: 2, et0: 4.5 })
    const nearStep = near.steps[0]
    console.log('模型间隔=' + nearStep.modelIntervalDays + ' 天，知识库=' + nearStep.knowledgeIntervalDays +
      ' 天，最终=' + nearStep.intervalDays + ' 天，corrected=' + nearStep.corrected)
    check('接近时不触发修正', nearStep.corrected, false)
    check('接近时采用模型值', nearStep.intervalDays, nearStep.modelIntervalDays)

    console.log('--- 2. 差得太多：按系数折中，仍偏向天气模型 ---')
    const far = project({ i0: 2.53, baseIntervalDays: 2, et0: 8.5 })
    const farStep = far.steps[0]
    const expected = Math.round((farStep.modelIntervalDays * 0.7 + farStep.knowledgeIntervalDays * 0.3) * 100) / 100
    console.log('模型间隔=' + farStep.modelIntervalDays + ' 天，知识库=' + farStep.knowledgeIntervalDays +
      ' 天，最终=' + farStep.intervalDays + ' 天（期望 ' + expected + '）')
    check('差异大时触发修正', farStep.corrected, true)
    check('修正值等于 0.7×模型 + 0.3×知识库', farStep.intervalDays, expected)
    check('修正结果比中间值更靠近天气模型',
      Math.abs(farStep.intervalDays - farStep.modelIntervalDays) <
        Math.abs(farStep.intervalDays - farStep.knowledgeIntervalDays), true)

    console.log('--- 3. 缓苗期：施肥提醒顺延到缓苗结束 ---')
    const created = await api('/plants', {
      method: 'POST',
      body: {
        name: '缓苗期校验月季',
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
    plantId = created.plant.id

    const list = await api('/plants/' + plantId + '/reminders', {}, token)
    const fertilizing = (list.reminders || []).find((r) => r.type === 'fertilizing')
    const pesticide = (list.reminders || []).find((r) => r.type === 'pesticide')
    const fertilizingDetail = await api('/reminders/' + fertilizing.id, {}, token)
    const fertilizingReminder = fertilizingDetail.reminder || {}

    console.log('施肥提醒：' + fertilizing.summary_text)
    console.log('肥料正文开头：' + String(fertilizingReminder.detail_content || '').slice(0, 60))
    const days = Math.round((new Date(fertilizing.due_at) - Date.now()) / 86400000)
    check('施肥提醒顺延到 14 天后', days >= 13 && days <= 14, true)
    check('施肥摘要说明缓苗期', /缓苗期/.test(fertilizing.summary_text || ''), true)
    check('施肥正文说明先不施肥', /先不要施肥|先不施肥/.test(fertilizingReminder.detail_content || ''), true)
    check('提醒里记录了缓苗期标记', Boolean(fertilizingReminder.meta && fertilizingReminder.meta.rest === 'transplant'), true)

    const otherDays = Math.round((new Date(pesticide.due_at) - Date.now()) / 86400000)
    check('打药提醒不受缓苗期影响', otherDays >= 6 && otherDays <= 7, true)

    console.log('--- 4. 没勾选刚移栽的植物不受影响 ---')
    const normal = await api('/plants', {
      method: 'POST',
      body: {
        name: '普通月季校验',
        species: '月季',
        growth_stage: '中苗',
        is_recent_transplant: 0,
        exposure: 'outdoor'
      }
    }, token)
    const normalList = await api('/plants/' + normal.plant.id + '/reminders', {}, token)
    const normalFert = (normalList.reminders || []).find((r) => r.type === 'fertilizing')
    const normalDays = Math.round((new Date(normalFert.due_at) - Date.now()) / 86400000)
    check('未勾选刚移栽时施肥提醒仍是 7 天后', normalDays >= 6 && normalDays <= 7, true)
    check('未勾选时没有缓苗期标记', !(normalFert.meta && normalFert.meta.rest), true)
    await api('/plants/' + normal.plant.id, { method: 'DELETE' }, token)
  } finally {
    if (plantId) {
      await api('/plants/' + plantId, { method: 'DELETE' }, token).catch(() => {})
      const left = db.prepare('SELECT COUNT(*) AS c FROM plant_reminders WHERE plant_id = ?').get(plantId).c
      console.log('清理临时植物：剩余提醒 ' + left + ' 条')
      if (left !== 0) failures++
    }
    db.close()
  }

  console.log(failures === 0 ? '\n全部检查通过' : '\n' + failures + ' 项检查未通过')
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack)
  process.exitCode = 1
})
