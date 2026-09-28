// 接口级验证：一键生成植物养护报告
// 1) 造一盆有养护记录的植物（完整档案 + 若干日记 + 完成若干提醒）
// 2) 生成报告：异步请求 → 轮询 → 拿到结构化报告
// 3) 校验统计数字与 AI 内容
const { getToken, api, check, openDb, deletePlant } = require('./lib')

async function waitForReport(token, requestId, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000))
    const data = await api('/report-requests/' + requestId, {}, token)
    const status = data.request && data.request.status
    console.log('  轮询状态：' + status)
    if (status === 'completed') return data.report
    if (status === 'failed') return { error: data.request.error_info }
  }
  return null
}

async function main() {
  const token = getToken()
  const db = openDb()
  let failures = 0
  let plantId = null

  try {
    const created = await api('/plants', {
      method: 'POST',
      body: {
        name: '报告测试月季',
        species: '月季',
        variety: '微型月季',
        growth_stage: '中苗',
        plant_source: '网购',
        exposure: 'open_balcony',
        soil_id: 'peat_mix',
        soil_type: '通用营养土（泥炭混合）',
        pot_size: '3 加仑',
        pot_depth_mm: 235,
        pot_diameter_mm: 245,
        location: '南阳台',
        light_environment: '上午半日照',
        planting_date: '2026-08-20',
        notes: '网购移栽的小苗'
      }
    }, token)
    plantId = created.plant.id
    console.log('测试植物 id=' + plantId)

    // 造养护记录
    await api('/plants/' + plantId + '/journal', { method: 'POST', body: { type: 'custom', content: '换到 3 加仑盆，浇透定根水' } }, token)
    await api('/plants/' + plantId + '/journal', { method: 'POST', body: { type: 'custom', content: '发现两片叶子有黑斑，先摘掉了' } }, token)
    await api('/plants/' + plantId + '/quick-action', { method: 'POST', body: { type: 'watering', content: '完成一次浇水' } }, token)
    await api('/plants/' + plantId + '/quick-action', { method: 'POST', body: { type: 'fertilizing', content: '浇了一次稀薄液肥' } }, token)

    // 完成一条提醒，让统计里有“完成提醒”
    const reminders = await api('/plants/' + plantId + '/reminders', {}, token)
    const target = reminders.reminders.find((item) => item.type === 'pruning' && item.status === 'pending')
    if (target) {
      await api('/reminders/' + target.id + '/complete', { method: 'POST' }, token)
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))

    const journals = await api('/plants/' + plantId + '/journal', {}, token)
    console.log('养护记录条数：' + journals.journals.length)

    // 生成报告
    console.log('\n开始生成报告（预计 1-3 分钟）...')
    const started = Date.now()
    const request = await api('/plants/' + plantId + '/report', { method: 'POST', body: {} }, token)
    console.log('请求号：' + request.request_id + '，状态：' + request.status)

    const report = await waitForReport(token, request.request_id)
    console.log('耗时 ' + Math.round((Date.now() - started) / 1000) + ' 秒')

    if (!report || report.error) {
      failures++
      console.log('FAIL | 报告生成失败：' + (report && report.error))
    } else {
      console.log('\n===== 报告 =====')
      console.log('标题：' + report.title)
      console.log('周期：' + report.period_text)
      console.log('统计：' + JSON.stringify(report.stats))
      console.log('总评：' + report.content.summary)
      report.content.sections.forEach((section) => {
        console.log(`\n【${section.heading}】\n${section.body}`)
      })
      console.log('\n亮点：' + JSON.stringify(report.content.highlights))
      console.log('下一步：' + JSON.stringify(report.content.next_actions))

      if (!check('有标题', report.title.length > 0, true)) failures++
      if (!check('有 4 个小节', report.content.sections.length >= 4, true)) failures++
      if (!check('有整体评价', report.content.summary.length > 10, true)) failures++
      if (!check('有亮点', report.content.highlights.length >= 2, true)) failures++
      if (!check('有下一步建议', report.content.next_actions.length >= 2, true)) failures++
      if (!check('统计含养护天数', report.stats.care_days > 0, true)) failures++
      if (!check('统计含记录条数', report.stats.journal_total >= 4, true)) failures++
      if (!check('统计含完成提醒', report.stats.reminder_completed >= 1, true)) failures++

      const history = await api('/plants/' + plantId + '/reports', {}, token)
      if (!check('报告进入历史列表', history.reports.length >= 1, true)) failures++
    }
  } finally {
    if (plantId) {
      await deletePlant(token, plantId).catch((err) => console.log('清理失败：' + err.message))
      const left = db.prepare('SELECT COUNT(*) AS c FROM plant_reminders WHERE plant_id = ?').get(plantId).c
      const leftReports = db.prepare('SELECT COUNT(*) AS c FROM reports WHERE plant_id = ?').get(plantId).c
      console.log('\n清理临时植物：剩余提醒 ' + left + ' 条，报告 ' + leftReports + ' 条')
      if (!check('临时数据已清理', left === 0 && leftReports === 0, true)) failures++
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
