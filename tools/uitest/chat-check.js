// 接口级验证：AI 精灵对话
// 1) 进入会话：返回开场白、历史消息、植物档案
// 2) 咨询问题：AI 结合档案与知识库回答，不产生任何数据修改
// 3) 要求改提醒：AI 只提出待确认变更，不直接落库
// 4) 用户确认后执行：删除旧的同类提醒、按新间隔重建、写养护历程
const { getToken, api, check, openDb, createTempPlant, deletePlant } = require('./lib')

async function main() {
  const token = getToken()
  const db = openDb()
  let failures = 0
  let plantId = null

  try {
    plantId = await createTempPlant(token, '对话测试', '月季')

    // 1) 进入会话
    const session = await api('/chat/gardener/session/' + plantId, {}, token)
    console.log('开场白：' + session.session.greeting)
    if (!check('返回开场白', session.session.greeting.length > 0, true)) failures++
    if (!check('开场白提到品种', session.session.greeting.includes('月季'), true)) failures++
    if (!check('返回植物档案', session.plant.name, '对话测试')) failures++

    // 2) 咨询问题
    console.log('\n发送咨询：叶子发黄怎么办？')
    let started = Date.now()
    const ask = await api('/chat/gardener', {
      method: 'POST',
      body: { plant_id: plantId, message: '我的月季叶子发黄，是不是缺肥？' }
    }, token)
    console.log('耗时 ' + Math.round((Date.now() - started) / 1000) + ' 秒')
    console.log('回复：' + ask.reply.slice(0, 220))
    console.log('提出的变更数：' + ask.pending_changes.length)
    if (!check('咨询有回复', ask.reply.length > 50, true)) failures++
    if (!check('咨询不产生变更', ask.pending_changes.length, 0)) failures++

    // 3) 要求改提醒
    console.log('\n发送修改请求：以后每 5 天浇一次水')
    // 先记下请求前的状态：确认前不应该发生任何改动
    // （浇水间隔现在由天气模型决定，不再是知识库固定值，所以只比较"有没有被改动"）
    const beforeChange = await api('/plants/' + plantId + '/reminders', {}, token)
    const wateringBefore = beforeChange.reminders.find((r) => r.type === 'watering' && r.status === 'pending')
    started = Date.now()
    const change = await api('/chat/gardener', {
      method: 'POST',
      body: { plant_id: plantId, message: '以后请每 5 天提醒我浇一次水' }
    }, token)
    console.log('耗时 ' + Math.round((Date.now() - started) / 1000) + ' 秒')
    console.log('回复：' + change.reply.slice(0, 200))
    console.log('待确认变更：' + JSON.stringify(change.pending_changes))

    if (!check('提出待确认变更', change.pending_changes.length > 0, true)) failures++
    if (!check('需要用户确认', change.need_confirm, true)) failures++

    const pending = change.pending_changes[0]
    if (pending) {
      if (!check('变更类型为提醒', pending.change_type, 'reminder')) failures++
      if (!check('变更类型是浇水', pending.fields.reminder_type, 'watering')) failures++
      if (!check('新间隔为 5 天', pending.fields.interval_days, 5)) failures++
    }

    // 确认前不应该改动数据：间隔与到期时间都要和请求前一致
    const pendingNow = await api('/plants/' + plantId + '/reminders', {}, token)
    const wateringNow = pendingNow.reminders.find((r) => r.type === 'watering' && r.status === 'pending')
    console.log('请求前后浇水提醒：间隔 ' + wateringBefore.interval_days + ' → ' + wateringNow.interval_days +
      ' 天，下一次 ' + wateringBefore.due_at + ' → ' + wateringNow.due_at)
    if (!check('确认前间隔未被改动', wateringNow.interval_days, wateringBefore.interval_days)) failures++
    if (!check('确认前到期时间未被改动', wateringNow.due_at, wateringBefore.due_at)) failures++

    // 4) 确认执行
    if (pending) {
      const executed = await api('/chat/gardener/execute', {
        method: 'POST',
        body: { plant_id: plantId, change_ids: [pending.id] }
      }, token)
      console.log('\n执行结果：' + JSON.stringify(executed.applied))
      if (!check('执行成功', executed.applied.length, 1)) failures++

      const after = await api('/plants/' + plantId + '/reminders', {}, token)
      const wateringAfter = after.reminders.find((r) => r.type === 'watering' && r.status === 'pending')
      console.log('调整后的浇水提醒：每 ' + wateringAfter.interval_days + ' 天，' + wateringAfter.due_label)
      if (!check('提醒已按新间隔重建', wateringAfter.interval_days, 5)) failures++

      const journals = await api('/plants/' + plantId + '/journal', {}, token)
      const changed = journals.journals.some((item) => item.content.includes('AI 精灵调整'))
      if (!check('写入养护历程', changed, true)) failures++

      const pendingAfter = await api('/plants/' + plantId + '/pending-changes?status=pending', {}, token)
      if (!check('变更已标记处理完成', pendingAfter.pending_changes.length, 0)) failures++
    }

    const messages = await api('/chat/gardener/session/' + plantId, {}, token)
    console.log('\n会话消息条数：' + messages.messages.length)
    if (!check('对话记录已保存', messages.messages.length >= 4, true)) failures++
  } finally {
    if (plantId) {
      await deletePlant(token, plantId).catch((err) => console.log('清理失败：' + err.message))
      const left = db.prepare('SELECT COUNT(*) AS c FROM plant_reminders WHERE plant_id = ?').get(plantId).c
      const leftMessages = db.prepare('SELECT COUNT(*) AS c FROM chat_messages WHERE plant_id = ?').get(plantId).c
      console.log('清理临时植物：剩余提醒 ' + left + ' 条，对话 ' + leftMessages + ' 条')
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
