// 拍「登录态过期」时的首页：往缓存塞无效 token 再进首页。
// 用途说明：这张图是配合"临时关掉自动重登"的构建拍的，
// 得到的就是用户在 2026-09-18 实际看到的那个画面。
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')

const SHOT_DIR = path.resolve(__dirname, 'shots-art')
const BAD_TOKEN = 'expired-token-simulated-by-test'

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })

  await miniProgram.evaluate((bad) => wx.setStorageSync('token', bad), BAD_TOKEN)
  await miniProgram.reLaunch('/pages/garden/garden')

  const page = await miniProgram.currentPage()
  const deadline = Date.now() + 40000
  let data = await page.data()
  while (data.loading && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    data = await page.data()
  }

  await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'session-expired-before.png') })
  console.log('页面上的提示：' + (data.error || '(没有报错)'))
  console.log('token 还是旧的吗：' + ((await miniProgram.evaluate(() => wx.getStorageSync('token'))) === BAD_TOKEN))

  await miniProgram.close()
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
