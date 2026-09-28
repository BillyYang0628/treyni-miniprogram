// 实操模拟测试：下一轮提醒的 AI 状态在界面上的表现
// 1) 列表显示“已按这盆植物调整”/“AI 建议生成失败，点进详情可重试”
// 2) 详情页显示调整理由；失败时显示错误与重新生成按钮
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { getToken, api, check, openDb, createTempPlant, deletePlant } = require('./lib')

const SHOT_DIR = path.resolve(__dirname, 'shots')

function seedReminder(db, plantId, options) {
  const now = new Date().toISOString()
  const result = db.prepare(`
    INSERT INTO plant_reminders (
      plant_id, user_id, type, title, content, summary_text, detail_content,
      due_at, interval_days, status, ai_status, ai_error, ai_reason, ai_model,
      ai_generated_at, created_at, updated_at
    ) VALUES (?, 1, 'watering', ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    plantId,
    options.title,
    options.detail,
    options.summary,
    options.detail,
    new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(),
    options.intervalDays,
    options.aiStatus,
    options.aiError || null,
    options.aiReason || null,
    options.aiStatus === 'done' ? 'ai' : 'daily_care',
    options.aiStatus === 'done' ? now : null,
    now,
    now
  )

  return Number(result.lastInsertRowid)
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const token = getToken()
  const db = openDb()
  let failures = 0
  let plantId = null
  let miniProgram = null

  try {
    plantId = await createTempPlant(token, 'AI状态界面测试', '月季')

    const doneId = seedReminder(db, plantId, {
      title: '浇水',
      summary: '两天后探土2厘米，干了就沿盆边浇透',
      detail: '① 先判断该不该浇：手指插进土面下 2-3 厘米，摸不到湿气再浇。\n② 浇就浇透：沿盆边慢浇到盆底出水。',
      intervalDays: 2,
      aiStatus: 'done',
      aiReason: '初秋月季正值秋花期，根系需要稳定水分，2 天检查一次既能防旱又不至于积水烂根。'
    })

    const failedId = seedReminder(db, plantId, {
      title: '浇水',
      summary: '给AI状态界面测试浇水：盆土干透再浇透',
      detail: '① 判断：盆土表面发白再浇。\n② 操作：沿盆边浇到盆底出水。',
      intervalDays: 2,
      aiStatus: 'failed',
      aiError: 'Moonshot 调用超时，请稍后重试'
    })

    miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
    await miniProgram.reLaunch('/pages/garden/garden')
    await miniProgram.navigateTo('/pages/plant-detail/plant-detail?id=' + plantId)
    let page = await miniProgram.currentPage()
    await page.waitFor(2500)

    const listData = await page.data()
    const doneItem = (listData.reminders || []).find((item) => item.id === doneId)
    const failedItem = (listData.reminders || []).find((item) => item.id === failedId)
    console.log('已调整提醒的标记：' + (doneItem && doneItem.aiStatusText))
    console.log('失败提醒的标记：' + (failedItem && failedItem.aiStatusText))

    if (!check('列表显示已调整标记', doneItem && doneItem.aiStatusText, '已按这盆植物调整')) failures++
    if (!check('列表显示失败标记', failedItem && failedItem.aiStatusText, 'AI 建议生成失败，点进详情可重试')) failures++
    if (!check('失败标记高亮', failedItem && failedItem.aiFailed, true)) failures++

    const shot1 = path.join(SHOT_DIR, 'next-reminder-list.png')
    await miniProgram.screenshot({ path: shot1 })

    // 打开已调整的提醒
    await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + doneId)
    page = await miniProgram.currentPage()
    await page.waitFor(2500)
    let detail = await page.data()
    console.log('详情 AI 块：' + detail.aiStatus + '，理由：' + detail.aiReason.slice(0, 40))
    if (!check('详情状态为 done', detail.aiStatus, 'done')) failures++
    if (!check('详情显示调整理由', detail.aiReason.length > 0, true)) failures++

    const shot2 = path.join(SHOT_DIR, 'next-reminder-done.png')
    await miniProgram.screenshot({ path: shot2 })

    // 打开失败的提醒
    await miniProgram.navigateBack()
    await page.waitFor(1200)
    await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + failedId)
    page = await miniProgram.currentPage()
    await page.waitFor(2500)
    detail = await page.data()
    console.log('失败详情：状态=' + detail.aiStatus + '，错误=' + detail.aiError)
    if (!check('详情状态为 failed', detail.aiStatus, 'failed')) failures++
    if (!check('详情显示错误信息', detail.aiError.length > 0, true)) failures++

    const retry = await page.$('.ai-card-failed .btn')
    if (!check('失败时提供重新生成按钮', Boolean(retry), true)) failures++

    const shot3 = path.join(SHOT_DIR, 'next-reminder-failed.png')
    await miniProgram.screenshot({ path: shot3 })
    console.log('截图已保存到 ' + SHOT_DIR)
  } finally {
    if (miniProgram) await miniProgram.close().catch(() => {})
    if (plantId) {
      await deletePlant(token, plantId).catch((err) => console.log('清理失败：' + err.message))
      const left = db.prepare('SELECT COUNT(*) AS c FROM plant_reminders WHERE plant_id = ?').get(plantId).c
      console.log('清理临时植物：剩余提醒 ' + left + ' 条')
      if (!check('临时数据已清理', left, 0)) failures++
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
