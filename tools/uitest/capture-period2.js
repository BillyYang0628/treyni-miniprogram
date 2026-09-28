/**
 * 第六批 · 期 2 的界面证据（提示词改动看不出"界面"，所以拍的就是模型输出落到界面上的样子）
 *
 *   ① period2-chat.png    AI 花农对话：A-5 降长（对照 ai9-shots\s8-01-chat-reply.png 的 765 字）
 *   ② period2-detail.png  打药提醒详情：A-1 配药安全 + B-3 分段渲染
 *   ③ period2-consult.png 换药建议：A-4 语言调教（对照 ai9-shots\s4-02-treatment-consult.png）
 *
 * 用法：node capture-period2.js
 */
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { getToken, api, openDb, createTempPlant, deletePlant, seedTreatmentPair } = require('./lib')

const SHOT_DIR = path.resolve(__dirname, 'shots-art')

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const token = getToken()
  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  const plantId = await createTempPlant(token, '期2截图', '月季')
  const db = openDb()

  const shot = (name) => miniProgram.screenshot({ path: path.join(SHOT_DIR, name) })

  try {
    // ---------- ① AI 花农对话：降长 ----------
    console.log('① 对话降长…')
    await api('/chat/gardener', {
      method: 'POST',
      body: { plant_id: plantId, message: '我家月季每天只有 4 小时光照，需要改档案吗？' }
    }, token)

    await miniProgram.reLaunch('/pages/garden/garden')
    await miniProgram.navigateTo('/pages/chat/chat?plant_id=' + plantId)
    let page = await miniProgram.currentPage()
    await page.waitFor(4000)
    await shot('period2-chat.png')
    console.log('   → period2-chat.png')

    // ---------- ② 打药提醒详情：配药安全 + 分段 ----------
    console.log('② 打药方案详情…')
    const list = await api('/plants/' + plantId + '/reminders', {}, token)
    const pest = (list.reminders || []).find((item) => item.type === 'pesticide')
    if (!pest) throw new Error('临时植物没有打药提醒')

    await api('/reminders/' + pest.id + '/detail', { method: 'POST', body: { force: true } }, token)

    await miniProgram.reLaunch('/pages/garden/garden')
    await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + pest.id)
    page = await miniProgram.currentPage()
    await page.waitFor(4000)
    await shot('period2-detail.png')
    // 配药那一条在 4) 安全注意里，滚下去才看得见
    await miniProgram.pageScrollTo(620)
    await page.waitFor(800)
    await shot('period2-detail-bottom.png')
    console.log('   → period2-detail.png / period2-detail-bottom.png')

    // ---------- ③ 换药建议：语言调教 ----------
    console.log('③ 换药建议（第 2 轮反馈"没改善"才会出现）…')
    const pair = seedTreatmentPair(db, plantId, 1, 2, 'period2-' + plantId, '黑斑病')

    await miniProgram.reLaunch('/pages/garden/garden')
    await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + pair.feedbackId)
    page = await miniProgram.currentPage()
    await page.waitFor(2500)

    // automator 选不到组件内部节点，直接调页面的处理器（项目既有做法）
    await page.callMethod('onFeedbackIneffective')
    // 换药建议现在是"关闭思考"模式，3-8 秒就能回来；这里轮询等结果，
    // 比定长等待靠谱（定长等 20 秒踩过一次：AI 还没回来就拍了空白页）
    let suggestion = ''
    for (let i = 0; i < 30; i++) {
      await page.waitFor(2000)
      suggestion = await page.data('suggestion')
      if (suggestion) break
      const error = await page.data('consultError')
      if (error) {
        console.warn('   页面报了 consultError：' + error)
        break
      }
    }
    await shot('period2-consult-top.png')

    console.log('   AI 建议 ' + String(suggestion || '').replace(/\s/g, '').length + ' 字')
    if (!suggestion) console.warn('   注意：没拿到 suggestion，AI 可能失败了')

    // 建议卡片在页面下方，滚下去再拍一张
    await miniProgram.pageScrollTo(700)
    await page.waitFor(800)
    await shot('period2-consult-bottom.png')
    console.log('   → period2-consult-top.png / period2-consult-bottom.png')
  } finally {
    db.close()
    await deletePlant(token, plantId).catch(() => {})
    await miniProgram.close().catch(() => {})
  }
}

main().catch((err) => {
  console.error('FAILED:', (err && err.message) || err)
  process.exit(1)
})
