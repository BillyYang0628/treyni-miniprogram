// 接口级验证：完成提醒后，下一轮提醒由 AI 结合档案 + 知识库 + 历史记录生成
// 1) 完成后立即生成下一轮，并标记 ai_status=pending
// 2) 后台 AI 完成后写回间隔 / 摘要 / 详情 / 理由，状态变 done
// 3) 失败时状态为 failed 并带错误信息（可重试）
const { getToken, api, check, openDb, createTempPlant, deletePlant } = require('./lib')

async function waitForAdvice(token, reminderId, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000))
    const data = await api('/reminders/' + reminderId, {}, token)
    console.log('  状态：' + (data.reminder.ai_status || '（无）'))
    if (data.reminder.ai_status && data.reminder.ai_status !== 'pending') {
      return data.reminder
    }
  }

  return null
}

async function main() {
  const token = getToken()
  const db = openDb()
  let failures = 0
  let plantId = null

  try {
    plantId = await createTempPlant(token, 'AI安排测试', '月季')

    const list = await api('/plants/' + plantId + '/reminders', {}, token)
    const watering = list.reminders.find((r) => r.type === 'watering' && r.status === 'pending')
    console.log('原始浇水提醒：间隔 ' + watering.interval_days + ' 天，到期 ' + watering.due_text)

    // 完成浇水提醒
    const done = await api('/reminders/' + watering.id + '/complete', { method: 'POST' }, token)
    const next = done.next_reminder
    console.log('完成后的下一轮：id=' + next.id + '，间隔 ' + next.interval_days +
      ' 天，状态 ' + next.ai_status + '，到期 ' + next.due_text)

    if (!check('完成后立即生成下一轮', Boolean(next), true)) failures++
    if (!check('下一轮标记为待 AI 安排', next.ai_status, 'pending')) failures++
    if (!check('下一轮先用知识库间隔', next.interval_days, 2)) failures++

    console.log('\n等待后台 AI 安排下一轮（约 1-3 分钟）...')
    const advised = await waitForAdvice(token, next.id)

    if (!advised) {
      failures++
      console.log('FAIL | AI 建议未在超时时间内完成')
    } else if (advised.ai_status === 'failed') {
      failures++
      console.log('FAIL | AI 建议生成失败：' + advised.ai_error)
    } else {
      console.log('\nAI 安排结果：')
      console.log('  间隔：' + advised.interval_days + ' 天（知识库标准 2 天）')
      console.log('  摘要：' + advised.summary_text)
      console.log('  理由：' + advised.ai_reason)
      console.log('  详情：' + String(advised.detail_content).slice(0, 160) + '...')

      if (!check('状态为已完成', advised.ai_status, 'done')) failures++
      if (!check('间隔已由 AI 决定', advised.interval_days > 0 && advised.interval_days <= 180, true)) failures++
      if (!check('写了调整理由', advised.ai_reason.length > 0, true)) failures++
      if (!check('详情由 AI 重写', advised.detail_content.length > 100, true)) failures++
      if (!check('标注为 AI 生成', advised.detail_source, 'ai')) failures++
    }
  } finally {
    if (plantId) {
      await deletePlant(token, plantId).catch((err) => console.log('清理失败：' + err.message))
      const left = db.prepare('SELECT COUNT(*) AS c FROM plant_reminders WHERE plant_id = ?').get(plantId).c
      const leftJournals = db.prepare('SELECT COUNT(*) AS c FROM plant_journal WHERE plant_id = ?').get(plantId).c
      console.log('清理临时植物：剩余提醒 ' + left + ' 条，历程 ' + leftJournals + ' 条')
      if (!check('临时数据已清理', left === 0 && leftJournals === 0, true)) failures++
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
