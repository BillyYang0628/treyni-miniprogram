// 微信开发者工具自动化连通性检查：连接模拟器并读取真实渲染的页面数据
const automator = require('miniprogram-automator')

async function main() {
  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  console.log('connected')

  const page = await miniProgram.reLaunch('/pages/garden/garden')
  await page.waitFor(1500)

  const current = await miniProgram.currentPage()
  console.log('current page:', current.path)

  const cards = await current.$$('.plant-card')
  console.log('plant cards rendered:', cards.length)

  const data = await current.data()
  console.log('plants in data:', (data.plants || []).map((p) => p.name + '/' + p.species))

  await miniProgram.close()
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err && err.message)
  process.exit(1)
})
