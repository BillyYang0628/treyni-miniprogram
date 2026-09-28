// 验证「后端自动同步局域网地址」这一版：
//   1) 小程序读到的候选地址里，第一个应该是后端启动时写进去的当前 IP
//   2) 首页能正常拿到数据，不报错
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')

const SHOT_DIR = path.resolve(__dirname, 'shots-art')

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (!ok) failures++
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })

  // 清掉手动覆盖，确保读的是"默认地址"这条路径
  await miniProgram.evaluate(() => wx.removeStorageSync('debug_baseUrl'))

  const info = await miniProgram.evaluate(() => {
    const config = getApp().globalData.config
    return {
      lanHosts: config.lanHosts,
      baseUrl: config.getBaseUrl(),
      order: config.getProbeOrder()
    }
  })

  console.log('后端写进小程序的地址列表: ' + JSON.stringify(info.lanHosts))
  console.log('当前生效地址: ' + info.baseUrl)
  console.log('自动切换候选顺序: ' + JSON.stringify(info.order))

  check('候选列表第一项是后端同步过来的当前 IP', info.lanHosts[0], '192.168.1.4')
  check('候选里还留着旧的网段', info.lanHosts.indexOf('10.11.21.3') !== -1, true)

  await miniProgram.reLaunch('/pages/garden/garden')
  const page = await miniProgram.currentPage()
  const deadline = Date.now() + 30000
  let data = await page.data()
  while (data.loading && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    data = await page.data()
  }
  await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'after-backend-autostart.png') })

  check('首页没有报错', data.error || '', '')
  check('拿到了植物数据', (data.plants || []).length > 0, true)
  console.log('植物数量=' + (data.plants || []).length)

  await miniProgram.close()
  console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项未通过')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
