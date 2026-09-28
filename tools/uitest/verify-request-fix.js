// 验证「真机 request fail」这套修复：
//   1) 正常地址下首页能拿到数据（不报错）
//   2) 故意把后端地址改成连不通的（模拟真机换网络后的旧 IP）→ 首页要明确报错，
//      并且把"当前地址"显示出来，而不是伪装成"还没有添加植物"
//   3) 再改回正常地址 → 首页恢复正常
// 每一步都截图到 shots-art\。
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')

const SHOT_DIR = path.resolve(__dirname, 'shots-art')
const BAD_URL = 'http://10.255.255.1:3000' // 不可路由，必然超时

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (!ok) failures++
  return ok
}

async function waitLoaded(page, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 40000)
  let data = await page.data()
  while (data.loading && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    data = await page.data()
  }
  return data
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })

  const setOverride = (value) =>
    miniProgram.evaluate((url) => {
      if (url) wx.setStorageSync('debug_baseUrl', url)
      else wx.removeStorageSync('debug_baseUrl')
    }, value)

  // app.js 把 config 挂在 globalData 上，页面里 require 不到模块时用它取
  const readBaseUrl = () =>
    miniProgram.evaluate(() => getApp().globalData.config.getBaseUrl())

  // ---- 1) 正常地址 ----
  await setOverride('')
  const normalBase = await readBaseUrl()
  console.log('默认后端地址: ' + normalBase)
  await miniProgram.reLaunch('/pages/garden/garden')
  let page = await miniProgram.currentPage()
  let data = await waitLoaded(page, 20000)
  await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'fix-1-normal.png') })
  check('正常地址下不报错', data.error || '', '')
  console.log('  植物数量=' + (data.plants || []).length + '  loading=' + data.loading)

  // ---- 2) 故意指向连不通的地址 ----
  await setOverride(BAD_URL)
  const badBase = await readBaseUrl()
  check('覆盖后地址生效', badBase, BAD_URL)
  await miniProgram.reLaunch('/pages/garden/garden')
  page = await miniProgram.currentPage()
  data = await waitLoaded(page, 40000)
  await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'fix-2-unreachable.png') })
  check('连不上时页面报错', Boolean(data.error), true)
  check('报错里带上了连不上的地址', String(data.error || '').indexOf('10.255.255.1') !== -1, true)
  check('报错不再是微信原始错误码',
    String(data.error || '').indexOf('request:fail') === -1, true)
  console.log('  页面提示：' + String(data.error || '').replace(/\n/g, ' / ').slice(0, 120) + '…')

  // ---- 3) 改回默认地址，点重试 ----
  await setOverride('')
  await (await page.$('.load-error .btn')).tap()
  // 点完要等 setData 把 loading 置 true，否则下面一读就是旧数据（测试竞态）
  await new Promise((resolve) => setTimeout(resolve, 800))
  data = await waitLoaded(page, 20000)
  await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'fix-3-recovered.png') })
  check('改回地址后重试成功', data.error || '', '')
  console.log('  植物数量=' + (data.plants || []).length)

  // ---- 4) 「我的」页的调试入口 ----
  await miniProgram.switchTab('/pages/profile/profile')
  const profile = await miniProgram.currentPage()
  await profile.waitFor(2500)
  const devRow = await profile.$('.debug-card')
  check('我的页出现调试入口', Boolean(devRow), true)
  const shown = devRow ? await (await devRow.$('.debug-url')).text() : ''
  check('调试入口显示当前地址', shown, (await readBaseUrl()))
  await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'fix-4-debug-entry.png') })

  await miniProgram.close()
  console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项未通过')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
