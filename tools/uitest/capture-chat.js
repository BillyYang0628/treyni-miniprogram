/**
 * 拍 AI 花农对话页：造一盆临时植物 → 让托蕾妮回一句 → 截图。
 *
 * 用途：改了气泡样式（styles/chat-bubble.wxss）之后，确认对话页没被带坏。
 * 用法：node capture-chat.js [输出文件名] [要问的问题]
 */
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { getToken, api, createTempPlant, deletePlant } = require('./lib')

const SHOT_DIR = path.resolve(__dirname, 'shots-art')
const OUT = process.argv[2] || 'chat-check.png'
const QUESTION = process.argv[3] || '我家月季每天只有 4 小时光照，需要改档案吗？'

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const token = getToken()
  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  const plantId = await createTempPlant(token, '对话页截图', '月季')

  try {
    await api('/chat/gardener', {
      method: 'POST',
      body: { plant_id: plantId, message: QUESTION }
    }, token)

    await miniProgram.reLaunch('/pages/garden/garden')
    await miniProgram.navigateTo('/pages/chat/chat?plant_id=' + plantId)
    const page = await miniProgram.currentPage()
    await page.waitFor(4000)

    // 回复长的时候，聊天区默认滚到底，前半句会被裁掉。
    // scrollTarget 是页面自己用的锚点，指到助手那条就能从回复开头看起。
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
    await deletePlant(token, plantId).catch(() => {})
    await miniProgram.close().catch(() => {})
  }
}

main().catch((err) => {
  console.error('FAILED:', (err && err.message) || err)
  process.exit(1)
})
