// 演示「后端没启动」时首页的提示改成了什么样。
//
// 不去动真正的后端进程，而是用「我的」页那个地址覆盖功能，把地址指到
// 127.0.0.1 上一个没人监听的端口——走的代码路径和「后端没起来」完全一样，
// 但失败是立刻返回的，不用等 15 秒超时。
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')

const SHOT_DIR = path.resolve(__dirname, 'shots-art')
const DEAD_LOOPBACK = 'http://127.0.0.1:3999'

async function waitLoaded(page, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000)
  let data = await page.data()
  while (data.loading && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200))
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

  // ---- 后端没起来（用没人监听的回环端口模拟）----
  await setOverride(DEAD_LOOPBACK)
  await miniProgram.reLaunch('/pages/garden/garden')
  let page = await miniProgram.currentPage()
  let data = await waitLoaded(page)
  await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'after-backend-down.png') })
  console.log('--- 后端连不上时的提示 ---')
  console.log(data.error)
  console.log('')

  // ---- 后端正常 ----
  await setOverride('')
  await miniProgram.reLaunch('/pages/garden/garden')
  page = await miniProgram.currentPage()
  data = await waitLoaded(page, 20000)
  await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'after-backend-up.png') })
  console.log('--- 地址恢复后 ---')
  console.log('error=' + (data.error || '(空)') + '  plants=' + (data.plants || []).length)

  await miniProgram.close()
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
