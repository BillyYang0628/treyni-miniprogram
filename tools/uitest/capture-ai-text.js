// 拍「AI 文本渲染」的界面：拿库里最长的那条操作方案来渲染。
// 用法：node capture-ai-text.js <后缀>   → shots-art/ai-text-<后缀>.png
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { openDb } = require('./lib')

const SHOT_DIR = path.resolve(__dirname, 'shots-art')
const SUFFIX = process.argv[2] || 'after'

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  // 找一条内容最长的提醒详情（最能体现实分段前后的差别）
  const db = openDb()
  const row = db
    .prepare("SELECT id, plant_id, type, length(detail_content) AS len FROM plant_reminders WHERE detail_content IS NOT NULL AND length(detail_content) > 300 ORDER BY length(detail_content) DESC LIMIT 1")
    .get()
  db.close()

  if (!row) {
    console.log('库里没有超过 300 字的提醒详情，换个演示物')
    process.exit(0)
  }
  console.log('用提醒 #' + row.id + '（' + row.type + '，' + row.len + ' 字）来截图')

  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  try {
    await miniProgram.reLaunch('/pages/garden/garden')
    await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + row.id)
    const page = await miniProgram.currentPage()
    await page.waitFor(5000)
    await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'ai-text-' + SUFFIX + '.png') })
    console.log('  截图：ai-text-' + SUFFIX + '.png')
  } finally {
    await miniProgram.close().catch(() => {})
  }
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
