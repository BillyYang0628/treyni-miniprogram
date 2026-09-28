// 实操模拟测试：AI 花农对话页
// 1) 从植物详情进入对话页，显示个性化开场白
// 2) 发送修改请求，收到回复和“待确认变更”卡片
// 3) 点“确认修改”后，提醒真的被改掉，并出现“已执行”提示
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { getToken, api, check, openDb, createTempPlant, deletePlant } = require('./lib')

const SHOT_DIR = path.resolve(__dirname, 'shots')

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const token = getToken()
  const db = openDb()
  let failures = 0
  let plantId = null
  let miniProgram = null

  try {
    plantId = await createTempPlant(token, '对话界面测试', '月季')

    miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
    await miniProgram.reLaunch('/pages/garden/garden')
    await miniProgram.navigateTo('/pages/plant-detail/plant-detail?id=' + plantId)
    let page = await miniProgram.currentPage()
    await page.waitFor(2500)

    // 点 AI花农 进入对话
    const buttons = await page.$$('.mini-btn-ai')
    console.log('植物详情上的 AI 按钮数量：' + buttons.length)
    await buttons[buttons.length - 1].tap()
    await page.waitFor(2500)

    page = await miniProgram.currentPage()
    if (!check('进入对话页', page.path, 'pages/chat/chat')) failures++

    let data = await page.data()
    console.log('开场白：' + (data.greeting || '').slice(0, 60) + '…')
    if (!check('显示开场白', (data.greeting || '').length > 0, true)) failures++
    if (!check('显示植物归属', Boolean(data.plant && data.plant.name), true)) failures++

    // 发送修改请求
    await page.setData({ input: '以后每 7 天提醒我浇一次水' })
    await page.waitFor(500)
    await (await page.$('.chat-send')).tap()
    console.log('已发送，等待托蕾妮回复...')

    const deadline = Date.now() + 420000
    let replied = false
    while (Date.now() < deadline) {
      await page.waitFor(5000)
      try {
        const current = await miniProgram.currentPage()
        if (current.path !== 'pages/chat/chat') {
          console.log('  页面已切换：' + current.path)
          page = current
          continue
        }
        page = current
        data = await page.data()
      } catch (err) {
        console.log('  读取页面失败，重试：' + err.message)
        continue
      }
      console.log('  等待中：已用 ' + data.elapsed + ' 秒')
      if (!data.sending) {
        replied = true
        break
      }
    }

    if (!replied) {
      failures++
      console.log('FAIL | 对话超时')
    } else {
      console.log('回复：' + String(data.messages[data.messages.length - 1].content).slice(0, 120))
      if (!check('收到回复', data.messages.length >= 2, true)) failures++
      if (!check('出现待确认变更', data.pendingChanges.length > 0, true)) failures++
      if (data.pendingChanges.length) {
        console.log('待确认：' + data.pendingChanges[0].text)
        if (!check('变更内容为浇水 7 天', String(data.pendingChanges[0].text).includes('7'), true)) failures++
      }

      await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'chat-change.png') })

      // 确认执行
      const confirmBtn = await page.$('.change-actions .mini-btn-primary')
      if (!check('提供确认修改按钮', Boolean(confirmBtn), true)) failures++
      await confirmBtn.tap()
      await page.waitFor(3000)

      const after = await page.data()
      console.log('确认后剩余待确认：' + after.pendingChanges.length)
      if (!check('确认后待确认清空', after.pendingChanges.length, 0)) failures++

      const list = await api('/plants/' + plantId + '/reminders', {}, token)
      const watering = list.reminders.find((r) => r.type === 'watering' && r.status === 'pending')
      console.log('调整后的浇水提醒：每 ' + watering.interval_days + ' 天')
      if (!check('提醒已按新间隔生效', watering.interval_days, 7)) failures++

      await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'chat-after-confirm.png') })
    }
  } finally {
    if (miniProgram) await miniProgram.close().catch(() => {})
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
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
