// 校验花园卡片上的日期已经格式化（不再直接铺数据库时间戳）
const automator = require('miniprogram-automator')

let failures = 0

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  try {
    await mp.reLaunch('/pages/garden/garden')
    const page = await mp.currentPage()
    await page.waitFor(3000)

    const cards = await page.$$('.plant-card')
    console.log('花园卡片数：' + cards.length)
    if (!cards.length) {
      console.log('备注 | 当前没有植物，无法验证卡片日期')
      return
    }

    const meta = await page.$$('.plant-card-meta')
    const text = await meta[0].text()
    console.log('卡片元信息：' + text)

    const raw = /\d{4}-\d{2}-\d{2}/.test(text)
    const formatted = /\d+月\d+日/.test(text)
    console.log((formatted && !raw ? 'PASS' : 'FAIL') + ' | 卡片日期已格式化 | 格式化=' + formatted + ' 原始时间戳=' + raw)
    if (!formatted || raw) failures++
  } finally {
    await mp.close().catch(() => {})
  }

  console.log(failures === 0 ? '\n全部检查通过' : '\n' + failures + ' 项检查未通过')
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack)
  process.exitCode = 1
})
