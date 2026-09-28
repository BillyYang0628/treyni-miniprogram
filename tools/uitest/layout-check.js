// 实操模拟测试：量一下提醒详情页正文有没有顶到卡片边缘。
//
// 2026-09-21 改：正文现在由 `ai-text` 组件渲染（分段 + 重点高亮），
// 而 automator **选不到自定义组件内部的节点**（项目已知限制，见 AGENTS.md），
// 所以量不到"正文到卡片边"这个间距了。改成两步：
//   ① 量卡片本身：卡片左右必须离屏幕边缘 ≥ 10px（卡片没贴边，正文才有内边距可言）；
//   ② 截图留档，正文和卡片的关系用眼睛看（截图在 shots/layout-detail.png）。
const automator = require('miniprogram-automator')
const { openDb, findReminderId } = require('./lib')
const path = require('node:path')
const fs = require('node:fs')

async function main() {
  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  // 提醒 id 不再写死（原来是 25）：挑一条四类养护提醒、而且已经有详情报文的，
  // 才量得到 .detail-card / .detail-text（反馈提醒那一类页面结构不一样，量不到）
  const db = openDb()
  const reminderId = findReminderId(db, {
    types: ['watering', 'fertilizing', 'pesticide', 'pruning'],
    status: 'pending',
    minDetailLength: 200
  }) || findReminderId(db, {
    types: ['watering', 'fertilizing', 'pesticide', 'pruning'],
    minDetailLength: 200
  })
  db.close()
  if (!reminderId) {
    console.error('FAILED: 库里没有带详细方案的提醒，先跑一次 detail-pages.js')
    process.exit(1)
  }
  console.log('用提醒 id=' + reminderId)

  await miniProgram.reLaunch('/pages/garden/garden')
  await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + reminderId)
  const page = await miniProgram.currentPage()
  await page.waitFor(2500)

  const card = await page.$('.detail-card')
  if (!card) {
    // 排不上就先把现场打出来，别只抛一句 null.offset
    const data = await page.data()
    console.log('页面：' + page.path + '｜isFeedback=' + data.isFeedback +
      '｜generating=' + data.generating + '｜有正文=' + Boolean(data.detailText) +
      '｜error=' + (data.error || '无'))
    console.log('选择器命中：.detail-card=' + Boolean(card))
    throw new Error('这条提醒没渲染出完整操作方案卡片（种子里挑一条非反馈、有详情的提醒）')
  }
  const data = await page.data()
  const cardBox = await card.offset()
  const cardSize = await card.size()
  const windowWidth = Number((await miniProgram.systemInfo()).windowWidth) || 375

  console.log('卡片  left=' + cardBox.left + ' width=' + cardSize.width)
  console.log('屏幕宽度 ' + windowWidth + 'px；正文由 ai-text 组件渲染（automator 量不到组件内部节点）')

  const leftGap = cardBox.left
  const rightGap = windowWidth - (cardBox.left + cardSize.width)
  console.log('卡片距屏幕左边 ' + Math.round(leftGap) + 'px，距屏幕右边 ' + Math.round(rightGap) + 'px')

  const ok = leftGap >= 10 && rightGap >= 10
  console.log(ok ? 'PASS | 卡片左右都没贴屏幕边（正文内边距由卡片 padding 保证）' : 'FAIL | 卡片贴边了')

  const shotDir = path.resolve(__dirname, 'shots')
  fs.mkdirSync(shotDir, { recursive: true })
  const shot = path.join(shotDir, 'layout-detail.png')
  await miniProgram.screenshot({ path: shot })
  console.log('截图留档 -> ' + shot + '（正文与卡片的关系看图确认）')
  console.log('提示：这条提醒有正文=' + Boolean(data.detailText))

  await miniProgram.close()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
