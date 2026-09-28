// 实操模拟测试：在微信开发者工具里完成用药效果询问的三种分支
const automator = require('miniprogram-automator')
const { getToken, api, check, openDb, seedTreatmentPair, createTempPlant, deletePlant } = require('./lib')

async function main() {
  const token = getToken()
  const db = openDb()
  let failures = 0
  let plantId = null

  try {
    plantId = await createTempPlant(token, '反馈界面测试')
    const cycleA = 'ui_cycle_a_' + Date.now()
    const cycleB = 'ui_cycle_b_' + Date.now()
    const cycleC = 'ui_cycle_c_' + Date.now()

    const pairA = seedTreatmentPair(db, plantId, 1, 1, cycleA, '黑斑病')
    const pairB = seedTreatmentPair(db, plantId, 1, 1, cycleB, '黑斑病')
    const pairC = seedTreatmentPair(db, plantId, 1, 2, cycleC, '黑斑病')
    console.log('临时植物 id=' + plantId + '，反馈提醒 id=' + [pairA.feedbackId, pairB.feedbackId, pairC.feedbackId].join('/'))

    const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
    await miniProgram.reLaunch('/pages/garden/garden')

    // 分支一：有效
    await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + pairA.feedbackId)
    let page = await miniProgram.currentPage()
    await page.waitFor(2500)

    const askData = await page.data()
    console.log('询问页：' + askData.resultTitle + '，isFeedback=' + askData.isFeedback + '，轮次=' + askData.feedbackRound)
    if (!check('反馈提醒显示询问界面', askData.isFeedback && askData.stage, 'ask')) failures++
    if (!check('显示轮次', askData.feedbackRound, 1)) failures++

    const yesBtn = await page.$('.feedback-yes')
    const noBtn = await page.$('.feedback-no')
    if (!check('有效按钮存在', Boolean(yesBtn), true)) failures++
    if (!check('无效按钮存在', Boolean(noBtn), true)) failures++

    await yesBtn.tap()
    await page.waitFor(2500)
    const afterYes = await page.data()
    console.log('选择有效后：' + afterYes.resultTitle)
    if (!check('有效后显示结束结果', afterYes.resultTitle, '本轮用药结束')) failures++
    if (!check('有效后进入结果页', afterYes.stage, 'result')) failures++

    // 分支二：无效（第 1 轮）-> 自动安排第 2 轮
    await miniProgram.navigateBack()
    await page.waitFor(1200)
    await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + pairB.feedbackId)
    page = await miniProgram.currentPage()
    await page.waitFor(2500)
    await (await page.$('.feedback-no')).tap()
    await page.waitFor(3000)

    const afterNo = await page.data()
    console.log('选择无效后：' + afterNo.resultTitle)
    console.log('新增提醒：' + afterNo.nextReminders.map((item) => item.text).join(' | '))
    if (!check('无效后安排第 2 轮', afterNo.resultTitle, '已安排第 2 轮喷药')) failures++
    if (!check('结果里列出两条新提醒', afterNo.nextReminders.length, 2)) failures++

    // 分支三：两轮无效 -> AI 判断 -> 采用方案
    await miniProgram.navigateBack()
    await page.waitFor(1200)
    await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + pairC.feedbackId)
    page = await miniProgram.currentPage()
    await page.waitFor(2500)
    await (await page.$('.feedback-no')).tap()
    await page.waitFor(4000)

    const consulting = await page.data()
    console.log('两轮无效后：stage=' + consulting.stage + '，' + consulting.estimateText)
    if (!check('进入 AI 判断阶段', consulting.stage, 'consult')) failures++
    if (!check('显示等待提示', consulting.consulting, true)) failures++

    const deadline = Date.now() + 260000
    let suggestion = ''
    while (Date.now() < deadline) {
      await page.waitFor(5000)
      const now = await page.data()
      console.log('  AI 判断中：已等待 ' + now.elapsed + ' 秒')
      if (!now.consulting) {
        suggestion = now.suggestion || ''
        console.log('建议长度：' + suggestion.length)
        console.log('建议开头：' + suggestion.slice(0, 100))
        if (!check('拿到 AI 调整方案', suggestion.length > 300, true)) failures++
        if (!check('AI 判断未报错', !now.consultError, true)) failures++
        break
      }
    }
    if (!suggestion) {
      failures++
      console.log('FAIL | AI 判断超时')
    } else {
      await (await page.$('.apply-plan')).tap()
      await page.waitFor(3500)
      const applied = await page.data()
      console.log('采用方案后：' + applied.resultTitle)
      if (!check('采用方案后显示结果', applied.resultTitle, '已采用调整方案')) failures++
      if (!check('结果里列出新的两条提醒', applied.nextReminders.length, 2)) failures++
    }

    await miniProgram.screenshot({ path: require('node:path').resolve(__dirname, 'shots', 'feedback-result.png') })
    await miniProgram.close()
  } finally {
    if (plantId) {
      await deletePlant(token, plantId).catch((err) => console.log('清理失败：' + err.message))
      const left = db.prepare('SELECT COUNT(*) AS c FROM plant_reminders WHERE plant_id = ?').get(plantId).c
      const leftJournals = db.prepare('SELECT COUNT(*) AS c FROM plant_journal WHERE plant_id = ?').get(plantId).c
      console.log('清理临时植物：剩余提醒 ' + left + ' 条，剩余历程 ' + leftJournals + ' 条')
      if (!check('临时数据已清理', left === 0 && leftJournals === 0, true)) failures++
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
