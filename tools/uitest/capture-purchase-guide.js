/**
 * 拍「购买指路」接进提示词之后的界面：提醒详情页底部那几句买药 / 买肥的建议。
 *
 * 打药提醒 → 药剂的搜索词与登记证号判据
 * 施肥提醒 → 磷酸二氢钾那种"名字太专业"的搜索词写法（用户点名要的例子）
 *
 * 用法：node capture-purchase-guide.js
 */
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { getToken, api, createTempPlant, deletePlant } = require('./lib')

const SHOT_DIR = path.resolve(__dirname, 'shots-art')

async function shootDetail(miniProgram, token, plantId, reminder, out) {
  await api('/reminders/' + reminder.id + '/detail', { method: 'POST', body: { force: true } }, token)
  const detail = await api('/reminders/' + reminder.id, {}, token)
  const text = String((detail.reminder && detail.reminder.detail_content) || '')
  const buyLine = text.split(/\n+/).find((line) => /搜|登记证|小包装/.test(line)) || '（没找到购买那句）'
  console.log('  ' + reminder.type + ' 的购买那句：' + buyLine)

  await miniProgram.reLaunch('/pages/garden/garden')
  await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + reminder.id)
  const page = await miniProgram.currentPage()
  await page.waitFor(4000)
  // 购买那句在正文末尾。页面能滚多远跟正文长度有关，滚一个固定值可能直接
  // 冲过头（实测 1200 只剩底部按钮），所以两个位置各拍一张，命名带 _a / _b。
  // 购买那句在正文末尾，页面能滚多远跟正文长度有关，滚固定值容易过头，
  // 所以几个位置各拍一张，挑"那句话完整在屏幕里"的那张。
  const offsets = process.argv[3] ? process.argv[3].split(',').map(Number) : [560, 700, 860]
  for (const offset of offsets) {
    await miniProgram.pageScrollTo(offset)
    await page.waitFor(700)
    const name = out.replace(/\.png$/, '') + '_' + offset + '.png'
    await miniProgram.screenshot({ path: path.join(SHOT_DIR, name) })
    console.log('  → ' + name + '（滚动 ' + offset + '）')
  }
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const token = getToken()
  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  const plantId = await createTempPlant(token, '购买指路截图', '月季')

  try {
    const list = await api('/plants/' + plantId + '/reminders', {}, token)
    const pesticide = (list.reminders || []).find((item) => item.type === 'pesticide')
    const fertilizing = (list.reminders || []).find((item) => item.type === 'fertilizing')
    if (!pesticide || !fertilizing) throw new Error('临时植物缺少打药 / 施肥提醒')

    console.log('打药提醒详情…')
    await shootDetail(miniProgram, token, plantId, pesticide, 'purchase-pesticide.png')

    console.log('施肥提醒详情…')
    await shootDetail(miniProgram, token, plantId, fertilizing, 'purchase-fertilizing.png')
  } finally {
    await deletePlant(token, plantId).catch(() => {})
    await miniProgram.close().catch(() => {})
  }
}

main().catch((err) => {
  console.error('FAILED:', (err && err.message) || err)
  process.exit(1)
})
