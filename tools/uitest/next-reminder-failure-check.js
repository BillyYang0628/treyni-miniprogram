// 接口级验证：AI 安排下一轮失败时，必须显式暴露错误并可重试
// 做法：构造一条待安排的提醒，用桩把 AI 调用改成抛错，检查状态与错误信息是否落库
const { getToken, api, check, openDb, createTempPlant, deletePlant } = require('./lib')

async function main() {
  const token = getToken()
  const db = openDb()
  let failures = 0
  let plantId = null

  try {
    plantId = await createTempPlant(token, 'AI失败测试', '月季')

    // 手工造一条待 AI 安排的浇水提醒
    const now = new Date().toISOString()
    const inserted = db.prepare(`
      INSERT INTO plant_reminders (
        plant_id, user_id, type, title, content, summary_text, detail_content,
        due_at, interval_days, status, ai_status, created_at, updated_at
      ) VALUES (?, 1, 'watering', '浇水', '待安排', '给测试植物浇水', '知识库标准内容',
        ?, 2, 'pending', 'pending', ?, ?)
    `).run(plantId, now, now, now)
    const reminderId = Number(inserted.lastInsertRowid)
    console.log('构造提醒 id=' + reminderId + '，状态 pending')

    // 用桩让 AI 抛错，走真实的服务层逻辑
    const aiAdapter = require('../../server/src/services/aiAdapter')
    const original = aiAdapter.generateNextReminderAdvice
    aiAdapter.generateNextReminderAdvice = async () => {
      throw new Error('模拟 AI 故障：Moonshot 调用超时')
    }

    const nextReminderService = require('../../server/src/services/nextReminder')
    let caught = null
    try {
      await nextReminderService.generateAdvice(db, reminderId)
    } catch (err) {
      caught = err
      nextReminderService.markFailed(db, reminderId, err.message)
    }

    aiAdapter.generateNextReminderAdvice = original

    if (!check('AI 故障会抛错给调用方', Boolean(caught), true)) failures++

    const row = db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(reminderId)
    console.log('失败后状态：' + row.ai_status + '，错误：' + row.ai_error)

    if (!check('状态标记为 failed', row.ai_status, 'failed')) failures++
    if (!check('错误信息已保存', String(row.ai_error).includes('模拟 AI 故障'), true)) failures++
    if (!check('没有静默改写间隔', row.interval_days, 2)) failures++
    if (!check('没有静默改写内容', row.detail_content, '知识库标准内容')) failures++

    // 接口层也要能看到失败状态（供前端显示重试）
    const detail = await api('/reminders/' + reminderId, {}, token)
    console.log('接口返回：ai_status=' + detail.reminder.ai_status + '，ai_error=' + detail.reminder.ai_error)
    if (!check('接口暴露失败状态', detail.reminder.ai_status, 'failed')) failures++
    if (!check('接口暴露错误信息', detail.reminder.ai_error.length > 0, true)) failures++
  } finally {
    if (plantId) {
      await deletePlant(token, plantId).catch((err) => console.log('清理失败：' + err.message))
      const left = db.prepare('SELECT COUNT(*) AS c FROM plant_reminders WHERE plant_id = ?').get(plantId).c
      console.log('清理临时植物：剩余提醒 ' + left + ' 条')
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
