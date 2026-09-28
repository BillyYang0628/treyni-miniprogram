// 订阅消息与“暂不调整”落库 验证
// 1) 微信 access_token 是否能取到（暴露 IP 白名单等问题）
// 2) 订阅消息模板未配置时，推送扫描要给出明确原因而不是静默跳过
// 3) 推送候选与文案（dry-run）
// 4) 用户选择“暂不调整方案”要真正落库（meta + 养护历程）
const { getToken, api, check, openDb, createTempPlant, deletePlant, seedTreatmentPair } = require('./lib')
const wechatToken = require('../../server/src/services/wechatToken')

async function main() {
  const token = getToken()
  const db = openDb()
  let failures = 0
  const plants = []

  try {
    // 1) access_token
    console.log('=== 一、微信 access_token ===')
    try {
      const accessToken = await wechatToken.getAccessToken()
      console.log('获取成功，长度 ' + accessToken.length + '，缓存信息 ' + JSON.stringify(wechatToken.getCacheInfo()))
      if (!check('access_token 可获取', accessToken.length > 20, true)) failures++
    } catch (err) {
      console.log('获取失败：' + err.message)
      console.log('（常见原因：小程序后台未把当前服务器 IP 加入「开发设置 → IP 白名单」）')
      failures++
    }

    // 2) 订阅配置
    console.log('\n=== 二、订阅消息配置 ===')
    const config = await api('/config/subscribe', {}, token)
    console.log('模板是否已配置：' + config.configured + '，扫描范围：未来 ' + config.scan_ahead_hours + ' 小时')
    if (!check('接口能返回模板配置状态', typeof config.configured, 'boolean')) failures++

    // 3) 候选与文案（dry-run）
    console.log('\n=== 三、推送候选（dry-run）===')
    const plantId = await createTempPlant(token, '推送测试', '月季')
    plants.push(plantId)

    // 把浇水提醒改到 2 小时后到期
    const reminders = await api('/plants/' + plantId + '/reminders', {}, token)
    const watering = reminders.reminders.find((item) => item.type === 'watering')
    const soon = new Date(Date.now() + 2 * 3600 * 1000).toISOString()
    db.prepare('UPDATE plant_reminders SET due_at = ? WHERE id = ?').run(soon, watering.id)

    const dry = await api('/reminders/push/run', { method: 'POST', body: { dry_run: true } }, token)
    console.log('候选 ' + dry.total + ' 条')
    dry.results.slice(0, 5).forEach((item) => {
      console.log(`  #${item.reminder_id} ${item.plant}｜${item.message.thing1.value}｜${item.message.thing3.value}`)
    })
    if (!check('能扫到即将到期的提醒', dry.results.some((item) => item.reminder_id === watering.id), true)) failures++

    // 真实扫描（模板未配置 → 必须给出明确原因）
    const real = await api('/reminders/push/run', { method: 'POST', body: {} }, token)
    const mine = real.results.find((item) => item.reminder_id === watering.id)
    console.log('真实扫描结果：' + JSON.stringify(mine))
    if (!config.configured) {
      if (!check('未配置模板时给出明确原因', mine && mine.skipped && mine.reason.includes('模板'), true)) failures++

      const row = db.prepare('SELECT meta_json FROM plant_reminders WHERE id = ?').get(watering.id)
      const meta = JSON.parse(row.meta_json || '{}')
      console.log('写入提醒的原因：' + meta.push_status + ' / ' + meta.push_error)
      if (!check('跳过原因写进提醒', meta.push_status, 'skipped')) failures++
    }

    // 4) 暂不调整落库
    console.log('\n=== 四、暂不调整方案落库 ===')
    const cycle = 'reject_' + Date.now()
    const pair = seedTreatmentPair(db, plantId, 1, 2, cycle, '黑斑病')
    const rejected = await api('/reminders/' + pair.feedbackId + '/treatment-consult/reject', {
      method: 'POST',
      body: { reason: '暂时不想换药，先观察几天' }
    }, token)
    console.log('拒绝结果：' + JSON.stringify(rejected))
    if (!check('拒绝接口返回成功', rejected.rejected, true)) failures++
    if (!check('记录拒绝时间', Boolean(rejected.rejected_at), true)) failures++

    const rejectedRow = db.prepare('SELECT meta_json FROM plant_reminders WHERE id = ?').get(pair.feedbackId)
    const rejectedMeta = JSON.parse(rejectedRow.meta_json || '{}')
    console.log('meta 里的拒绝信息：' + JSON.stringify({
      at: rejectedMeta.adjustment_rejected_at,
      reason: rejectedMeta.adjustment_reject_reason
    }))
    if (!check('meta 记录拒绝时间', Boolean(rejectedMeta.adjustment_rejected_at), true)) failures++
    if (!check('meta 记录拒绝原因', rejectedMeta.adjustment_reject_reason, '暂时不想换药，先观察几天')) failures++

    const journals = await api('/plants/' + plantId + '/journal', {}, token)
    const found = journals.journals.some((item) => item.content.includes('暂不采用 AI 调整方案'))
    console.log('养护历程里有拒绝记录：' + found)
    if (!check('写入养护历程', found, true)) failures++
  } finally {
    for (const id of plants) {
      await deletePlant(token, id).catch((err) => console.log('清理失败：' + err.message))
      const left = db.prepare('SELECT COUNT(*) AS c FROM plant_reminders WHERE plant_id = ?').get(id).c
      console.log('清理临时植物 #' + id + '：剩余提醒 ' + left + ' 条')
      if (!check('临时数据已清理', left, 0)) failures++
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
