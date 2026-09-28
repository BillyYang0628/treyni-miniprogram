/**
 * 拍「AI 花农知不知道用户刚完成过什么」这一组对比图。
 *
 * 场景：先完成一次施肥（勾上「花多多1号」），再在对话里问「我上次施肥用的是什么」。
 * 改动前它会答不上来或按知识库猜；改动后应该直接引用户当时勾的那一项。
 *
 * 用法：node capture-chat-recent.js before|after [文件名]
 */
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { getToken, api, openDb, createTempPlant, deletePlant } = require('./lib')

const PHASE = process.argv[2] || 'before'
const OUT = process.argv[3] || ('chat-recent-' + PHASE + '.png')
const SHOT_DIR = path.resolve(__dirname, 'shots-art')
const QUESTION = '我上次施肥用的是什么？'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const token = getToken()
  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  const plantId = await createTempPlant(token, '对话完成记录', '月季')
  const db = openDb()

  try {
    // 等默认提醒建好
    let list = null
    for (let i = 0; i < 20; i++) {
      list = await api('/plants/' + plantId + '/reminders', {}, token)
      if ((list.reminders || []).some((item) => item.type === 'fertilizing')) break
      await sleep(1000)
    }
    const fert = (list.reminders || []).find((item) => item.type === 'fertilizing')
    if (!fert) throw new Error('临时植物没有施肥提醒')

    // 完成一次施肥，并在登记面板里勾上「花多多1号」
    const res = await fetch('http://127.0.0.1:3000/reminders/' + fert.id + '/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ done_items: ['花多多1号'], occurred_at: new Date().toISOString().slice(0, 10) })
    })
    console.log('完成施肥 → HTTP ' + res.status)

    // 让托蕾妮就这个问题回答一句
    const reply = await api('/chat/gardener', {
      method: 'POST',
      body: { plant_id: plantId, message: QUESTION }
    }, token)
    console.log('提问：' + QUESTION)
    console.log('回答：' + String(reply.reply || '').replace(/\s+/g, ' '))

    await miniProgram.reLaunch('/pages/garden/garden')
    await miniProgram.navigateTo('/pages/chat/chat?plant_id=' + plantId)
    const page = await miniProgram.currentPage()
    await page.waitFor(4000)

    const messages = (await page.data('messages')) || []
    const lastAssistant = messages.map((item, index) => (item.role === 'assistant' ? index : -1))
      .filter((index) => index >= 0).pop()
    if (lastAssistant !== undefined) {
      await page.setData({ scrollTarget: 'msg-' + lastAssistant })
      await page.waitFor(1200)
    }

    await miniProgram.screenshot({ path: path.join(SHOT_DIR, OUT) })
    console.log('截图：' + OUT)
  } finally {
    db.close()
    await deletePlant(token, plantId).catch(() => {})
    await miniProgram.close().catch(() => {})
  }
}

main().catch((err) => {
  console.error('FAILED: ' + ((err && err.message) || err))
  process.exit(1)
})
