// 复现「真机一进去就 request fail」：把模拟器指向一个连不上的后端地址，
// 进去首页后立刻截图，赶在 toast 消失之前把现象拍下来。
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')

const SHOT_DIR = path.resolve(__dirname, 'shots-art')

async function main() {
  const outName = process.argv[2] || 'repro-request-fail'
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  await miniProgram.reLaunch('/pages/garden/garden')
  const page = await miniProgram.currentPage()

  // 失败之后 toast 只活 1.5 秒，靠"固定等 N 秒"抓不稳，
  // 所以每 200ms 问一次页面数据，loading 一翻成 false 就立刻截图。
  const deadline = Date.now() + 40000
  let data = await page.data()
  while (data.loading && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    data = await page.data()
  }
  await miniProgram.screenshot({ path: path.join(SHOT_DIR, outName + '.png') })
  console.log('截图 -> ' + path.join(SHOT_DIR, outName + '.png'))
  console.log('loading=' + data.loading + ' plants=' + (data.plants || []).length)
  if (data.error) console.log('页面 error=' + data.error)
  await miniProgram.close()
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
