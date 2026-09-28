// 验证「换网络后自愈」这一版：
//   1) 把地址设成一个连不通的地址（模拟换网络后的旧 IP）
//   2) 首页发请求失败后，应该自动顺着候选地址试，试通就切过去并记住
//   3) 报错卡片上要有「改地址」入口（用 setData 造出错误态来验证布局）
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')

const SHOT_DIR = path.resolve(__dirname, 'shots-art')
const DEAD = 'http://10.11.21.3:3000' // 换网络前的旧地址，现在确实连不通

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (!ok) failures++
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  const setOverride = (value) =>
    miniProgram.evaluate((url) => {
      if (url) wx.setStorageSync('debug_baseUrl', url)
      else wx.removeStorageSync('debug_baseUrl')
    }, value)
  const readBaseUrl = () => miniProgram.evaluate(() => getApp().globalData.config.getBaseUrl())
  const readOverride = () => miniProgram.evaluate(() => getApp().globalData.config.getOverrideBaseUrl())

  // ---- 1) 先把地址指到"换网络前的旧 IP" ----
  await setOverride(DEAD)
  check('改前地址是旧 IP', await readBaseUrl(), DEAD)

  // ---- 2) 进首页，等它自己切 ----
  await miniProgram.reLaunch('/pages/garden/garden')
  const page = await miniProgram.currentPage()
  const deadline = Date.now() + 60000
  let data = await page.data()
  while (data.loading && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    data = await page.data()
  }
  await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'fallback-recovered.png') })

  const nowBase = await readBaseUrl()
  console.log('自动切换后的地址: ' + nowBase)
  check('没有落到错误卡片', data.error || '', '')
  check('拿到了植物数据', (data.plants || []).length > 0, true)
  check('地址已经换掉', nowBase !== DEAD, true)
  check('切换结果写进了缓存', await readOverride(), nowBase)

  // ---- 3) 报错卡片的布局（用 setData 造出错误态，不动后端）----
  // 等自动切换那条 toast 消失，免得截进对比图里
  await page.waitFor(3000)
  await page.setData({
    loading: false,
    error: '连不上后端（192.168.55.176:3000）。\n' +
      '这是给真机用的局域网地址，依次检查：\n' +
      '1. 电脑上的后端是否在运行（项目根目录的 start-server.cmd）；\n' +
      '2. 手机和电脑是否连在同一个 Wi-Fi（有些公共 Wi-Fi 会互相隔离）；\n' +
      '3. 这个地址是不是电脑当前的局域网地址——换网络后 IP 会变，\n' +
      '   后端启动时会打印新地址，点下面的「改地址」填进去即可。',
    serverUrl: 'http://192.168.55.176:3000'
  })
  await page.waitFor(600)
  const buttons = await page.$$('.load-error-actions .btn')
  const labels = []
  for (const b of buttons) labels.push((await b.text()).trim())
  console.log('报错卡片上的按钮：' + JSON.stringify(labels))
  check('报错卡片有 2 个按钮（重试 + 改地址）', buttons.length, 2)
  check('第二个按钮是改地址', labels[1], '改地址')
  await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'error-card-edit-address.png') })

  // ---- 收尾：清掉手动地址，恢复默认 ----
  await setOverride('')
  console.log('已恢复默认地址: ' + (await readBaseUrl()))

  await miniProgram.close()
  console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项未通过')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
