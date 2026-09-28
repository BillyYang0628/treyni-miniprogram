// 校验「所有提醒更新都走 AI 分析」：
//   1) 完成浇水提醒 → 天气模型算日期 + AI 写文案（ai_model = water_model+ai）
//   2) 完成施肥/打药/修剪提醒 → AI 安排下一轮（ai_model = ai）
//   3) 手动「重新安排下一轮」→ 浇水也先重算天气、再由 AI 写文案
//   4) AI 失败时显式标记 failed，不静默保留
const { getToken, api, openDb } = require('./lib')

let failures = 0

function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (!ok) failures++
}

function info(text) {
  console.log('     · ' + text)
}

async function waitAdvice(token, plantId, type, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const list = await api('/plants/' + plantId + '/reminders', {}, token)
    const target = (list.reminders || []).find((r) => r.type === type && r.status !== 'completed')
    if (target && target.ai_status && target.ai_status !== 'pending') return target
    await new Promise((r) => setTimeout(r, 3000))
  }
  return null
}

async function main() {
  const token = getToken()
  const db = openDb()
  const created = []

  try {
    const plant = await api('/plants', {
      method: 'POST',
      body: {
        name: '全提醒AI校验',
        species: '月季',
        growth_stage: '中苗',
        exposure: 'outdoor',
        soil_id: 'peat_mix',
        soil_type: '通用营养土（泥炭混合）',
        pot_size: '3 加仑',
        pot_depth_mm: 235,
        pot_diameter_mm: 245
      }
    }, token)
    const plantId = plant.plant.id
    created.push(plantId)

    // 1) 浇水：完成 → 天气模型 + AI
    let list = await api('/plants/' + plantId + '/reminders', {}, token)
    const watering = list.reminders.find((r) => r.type === 'watering')
    await api('/reminders/' + watering.id + '/complete', { method: 'POST' }, token)
    const nextWater = await waitAdvice(token, plantId, 'watering')
    if (!nextWater) {
      check('完成浇水后生成下一轮', false, true)
    } else {
      check('下一轮浇水状态为已完成分析', nextWater.ai_status, 'done')
      const row = db.prepare('SELECT ai_model, ai_generated_at, due_at, interval_days FROM plant_reminders WHERE id = ?')
        .get(nextWater.id)
      info('下一轮浇水 #' + nextWater.id + '：ai_model=' + row.ai_model + '，间隔 ' + row.interval_days +
        ' 天，下一次 ' + row.due_at)
      check('浇水也走了 AI 分析', row.ai_model, 'water_model+ai')
      check('AI 写入了调整理由', String(nextWater.ai_reason || '').length > 0, true)
      info('下一轮浇水摘要：' + nextWater.summary_text)
      // 天气模型自带的模板是「预计 M月D日给<植物名>浇水」，AI 改写后不会长这样
      check('摘要已由 AI 改写（不是天气模型模板）',
        /^预计 \d+ 月 \d+ 日给.+浇水$/.test(String(nextWater.summary_text || '').trim()), false)
      check('摘要非空', String(nextWater.summary_text || '').length > 0, true)
      check('日期仍由天气模型决定', Boolean(nextWater.water && nextWater.water.next_due_date), true)
    }

    // 2) 施肥：完成 → 纯 AI 安排
    list = await api('/plants/' + plantId + '/reminders', {}, token)
    const fert = list.reminders.find((r) => r.type === 'fertilizing')
    await api('/reminders/' + fert.id + '/complete', { method: 'POST' }, token)
    const nextFert = await waitAdvice(token, plantId, 'fertilizing')
    if (!nextFert) {
      check('完成施肥后生成下一轮', false, true)
    } else {
      const row = db.prepare('SELECT ai_model FROM plant_reminders WHERE id = ?').get(nextFert.id)
      check('施肥下一轮由 AI 安排', row.ai_model, 'ai')
      check('AI 给出了间隔与理由', Number(nextFert.interval_days) > 0 && String(nextFert.ai_reason || '').length > 0, true)
      info('施肥下一轮：' + nextFert.interval_days + ' 天｜' + nextFert.summary_text)
    }

    // 3) 手动重新安排下一轮（浇水）→ 天气模型 + AI
    list = await api('/plants/' + plantId + '/reminders', {}, token)
    const waterNow = list.reminders.find((r) => r.type === 'watering' && r.status !== 'completed')
    const before = db.prepare('SELECT ai_model, due_at FROM plant_reminders WHERE id = ?').get(waterNow.id)
    await api('/reminders/' + waterNow.id + '/ai-advice', { method: 'POST' }, token)
    const after = db.prepare('SELECT ai_model, due_at, ai_status, summary_text, ai_reason FROM plant_reminders WHERE id = ?')
      .get(waterNow.id)
    info('重新安排：' + before.ai_model + ' → ' + after.ai_model + '，下一次 ' + after.due_at)
    check('重新安排后仍是天气模型 + AI', after.ai_model, 'water_model+ai')
    check('重新安排后状态正常', after.ai_status, 'done')
    check('重新安排后有 AI 理由', String(after.ai_reason || '').length > 0, true)

    // 4) 其余养护类型（打药、修剪）也必须由 AI 安排
    for (const type of ['pesticide', 'pruning']) {
      list = await api('/plants/' + plantId + '/reminders', {}, token)
      const target = list.reminders.find((r) => r.type === type && r.status !== 'completed')
      if (!target) { check('存在待办提醒：' + type, false, true); continue }
      await api('/reminders/' + target.id + '/complete', { method: 'POST' }, token)
      const next = await waitAdvice(token, plantId, type)
      if (!next) { check('完成' + type + '后生成下一轮', false, true); continue }
      const row = db.prepare('SELECT ai_model FROM plant_reminders WHERE id = ?').get(next.id)
      check(type + ' 下一轮由 AI 安排', row.ai_model, 'ai')
    }

    // 5) 库里不应存在"既没走 AI 也没被标记"的待办提醒
    const pending = db.prepare(`
      SELECT type, ai_status, ai_model FROM plant_reminders
      WHERE plant_id = ? AND status = 'pending'
    `).all(plantId)
    const unexplained = pending.filter((r) => !r.ai_status && !r.ai_model)
    info('待办提醒：' + pending.map((r) => r.type + '(' + (r.ai_model || '—') + '/' + (r.ai_status || '—') + ')').join('，'))
    check('没有来源不明的待办提醒', unexplained.length, 0)
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
