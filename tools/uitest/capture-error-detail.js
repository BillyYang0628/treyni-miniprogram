// 拍一张真实的「首页报错卡片」截图，用来确认诊断信息那一行长什么样。
//
// 前提：跑这个脚本的时候，后端要处于**停止**状态——只要有一个候选地址活着，
// 自动切换就会把请求救回来，报错卡片根本不会出现。
// 所以这一步要配合"临时停后端"一起做（见 AGENTS.md 的说明）。
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')

const SHOT_DIR = path.resolve(__dirname, 'shots-art')
const DEAD = 'http://127.0.0.1:3999' // 没人监听，失败得很快，不用等 15 秒

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })

  await miniProgram.evaluate((url) => wx.setStorageSync('debug_baseUrl', url), DEAD)
  await miniProgram.reLaunch('/pages/garden/garden')
  const page = await miniProgram.currentPage()

  // 等报错卡片出现（所有候选都探不通才会走到这一步，可能要十几秒）
  const deadline = Date.now() + 60000
  let data = await page.data()
  while (!data.error && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    data = await page.data()
  }

  await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'error-card-diagnostic.png') })
  console.log('--- 报错卡片上的完整文字 ---')
  console.log(data.error || '(没等到报错卡片)')
  console.log('--- 当前地址 ---')
  console.log(data.serverUrl)

  // 收尾：把地址改回默认，免得影响后面的测试
  await miniProgram.evaluate(() => wx.removeStorageSync('debug_baseUrl'))
  await miniProgram.close()
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
