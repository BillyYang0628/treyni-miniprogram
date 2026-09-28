// 接口级验证：天气驱动浇水提醒
// 1) 设置城市（和风 GeoAPI）
// 2) 新建植物后，浇水提醒直接按天气模型算出日期与原因
// 3) 完成浇水后记录事件（含实时天气快照），并按新天气重算下一次
const { getToken, api, check, openDb, deletePlant } = require('./lib')

async function waitForWaterPlan(token, reminderId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const data = await api('/reminders/' + reminderId, {}, token)
    if (data.reminder.ai_status && data.reminder.ai_status !== 'pending') return data.reminder
  }
  return null
}

async function main() {
  const token = getToken()
  const db = openDb()
  let failures = 0
  let plantId = null

  try {
    // 1) 城市检索与设置
    const search = await api('/weather/city-search?keyword=' + encodeURIComponent('上海'), {}, token)
    console.log('城市候选：' + search.cities.slice(0, 3).map((c) => `${c.name}(${c.id})`).join('、'))
    if (!check('城市检索有结果', search.cities.length > 0, true)) failures++

    const saved = await api('/users/me/location', { method: 'PUT', body: { city: '上海' } }, token)
    console.log('已设置城市：' + saved.location.city + ' / ' + saved.location.location_id)
    if (!check('城市已保存', saved.location.city, '上海')) failures++

    const current = await api('/weather/current', {}, token)
    console.log('当前天气：' + current.now.text + ' ' + current.now.temp + '℃ 湿度' + current.now.humidity + '%')
    console.log('未来三天：' + current.daily.map((d) => `${d.date} ${d.tmin}~${d.tmax}℃ 雨${d.rainMm}mm`).join(' | '))
    if (!check('能取到实时天气', Number.isFinite(current.now.temp), true)) failures++

    // 2) 新建植物 → 浇水提醒按模型计算
    const created = await api('/plants', {
      method: 'POST',
      body: {
        name: '天气浇水测试',
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
    plantId = created.plant.id

    const reminders = await api('/plants/' + plantId + '/reminders', {}, token)
    const watering = reminders.reminders.find((item) => item.type === 'watering' && item.status === 'pending')
    console.log('\n初始浇水提醒：间隔 ' + watering.interval_days + ' 天，状态 ' + watering.ai_status)

    const planned = await waitForWaterPlan(token, watering.id)
    if (!planned) {
      failures++
      console.log('FAIL | 浇水提醒未完成模型计算')
    } else {
      console.log('模型结果：')
      console.log('  下次浇水：' + planned.due_at)
      console.log('  间隔：' + planned.interval_days + ' 天（知识库基准 2 天）')
      console.log('  摘要：' + planned.summary_text)
      console.log('  原因：' + planned.ai_reason)
      if (!check('模型已写入', planned.ai_status, 'done')) failures++
      if (!check('来源是天气模型', planned.detail_source, 'water_model')) failures++
      if (!check('写了原因', planned.ai_reason.includes('上海'), true)) failures++
      if (!check('间隔合理', planned.interval_days >= 1 && planned.interval_days <= 6, true)) failures++
    }

    // 3) 完成浇水 → 记录事件 + 重算下一次
    const done = await api('/reminders/' + watering.id + '/complete', { method: 'POST' }, token)
    console.log('\n完成浇水后新提醒：id=' + done.next_reminder.id + '，状态 ' + done.next_reminder.ai_status)

    await new Promise((resolve) => setTimeout(resolve, 2000))
    const events = db.prepare('SELECT event_type, happened_at, weather_json FROM plant_water_events WHERE plant_id = ? ORDER BY id DESC').all(plantId)
    console.log('浇水事件记录：' + events.length + ' 条')
    if (events.length) {
      const snapshot = JSON.parse(events[0].weather_json || '{}')
      console.log('  事件时间：' + events[0].happened_at + '，当时天气：' + (snapshot.text || '—') + ' ' + (snapshot.temp || '—') + '℃')
    }
    if (!check('已记录浇水事件', events.length >= 1, true)) failures++

    const nextPlanned = await waitForWaterPlan(token, done.next_reminder.id)
    if (!nextPlanned) {
      failures++
      console.log('FAIL | 下一次浇水未重算')
    } else {
      console.log('下一次浇水：' + nextPlanned.due_at + '（间隔 ' + nextPlanned.interval_days + ' 天）')
      console.log('原因：' + nextPlanned.ai_reason)
      if (!check('下一次已重算', nextPlanned.ai_status, 'done')) failures++
    }
  } finally {
    if (plantId) {
      await deletePlant(token, plantId).catch((err) => console.log('清理失败：' + err.message))
      const left = db.prepare('SELECT COUNT(*) AS c FROM plant_reminders WHERE plant_id = ?').get(plantId).c
      const events = db.prepare('SELECT COUNT(*) AS c FROM plant_water_events WHERE plant_id = ?').get(plantId).c
      console.log('清理临时植物：剩余提醒 ' + left + ' 条，浇水事件 ' + events + ' 条（随植物级联删除）')
      if (!check('临时数据已清理', left === 0, true)) failures++
    }
    db.close()
  }

  console.log(failures === 0 ? '\n全部检查通过' : '\n' + failures + ' 项检查未通过')
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exitCode = 1
})
