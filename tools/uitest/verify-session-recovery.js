// 验证「登录态过期自动重登」：
//   1) 往缓存里塞一个无效 token（模拟过期）
//   2) 进首页 —— 后端会返回 401，客户端应该自动重新登录并把这次请求重发
//   3) 结果：页面正常出数据，缓存里的 token 已经换成新的
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')

const SHOT_DIR = path.resolve(__dirname, 'shots-art')
const BAD_TOKEN = 'expired-token-simulated-by-test'

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (!ok) failures++
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })

  // ---- 1) 塞一个无效 token ----
  const before = await miniProgram.evaluate((bad) => {
    wx.setStorageSync('token', bad)
    return wx.getStorageSync('token')
  }, BAD_TOKEN)
  check('已把缓存里的 token 改成无效值', before, BAD_TOKEN)

  // ---- 2) 进首页 ----
  await miniProgram.reLaunch('/pages/garden/garden')
  const page = await miniProgram.currentPage()
  const deadline = Date.now() + 40000
  let data = await page.data()
  while (data.loading && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    data = await page.data()
  }
  await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'session-recovered.png') })

  const after = await miniProgram.evaluate(() => wx.getStorageSync('token'))

  // ---- 3) 断言 ----
  check('首页没有报错', data.error || '', '')
  check('拿到了植物数据（说明请求被救回来了）', (data.plants || []).length > 0, true)
  check('token 已经换成新的', after !== BAD_TOKEN && after.length > 20, true)
  console.log('  新 token 前 12 位: ' + String(after).slice(0, 12) + '…（长度 ' + String(after).length + '）')
  console.log('  植物数量: ' + (data.plants || []).length)

  await miniProgram.close()
  console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项未通过')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
