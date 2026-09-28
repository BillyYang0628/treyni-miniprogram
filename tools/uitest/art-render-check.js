// 直接问模拟器：页面上真正渲染出来的 <image> 用的是哪个文件。
// 比看截图可靠——截图放大后小图标容易认错。
const automator = require('miniprogram-automator')
const { getToken, createTempPlant, deletePlant } = require('./lib')

function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | ' + actual)
  return ok
}

async function main() {
  const token = getToken()
  let plantId = null
  let miniProgram = null
  let failures = 0

  try {
    plantId = await createTempPlant(token, '头像渲染验证', '月季')
    miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
    await miniProgram.reLaunch('/pages/garden/garden')
    await miniProgram.navigateTo('/pages/chat/chat?plant_id=' + plantId)
    const page = await miniProgram.currentPage()
    await page.waitFor(3000)

    await page.setData({
      messages: [
        { role: 'user', content: '叶子发黄怎么办', timeText: '9月16日 18:02' },
        { role: 'assistant', content: '先停两天水看看。', timeText: '9月16日 18:02' },
        { role: 'system', content: '已执行：把浇水改成每 5 天一次', timeText: '9月16日 18:03' }
      ]
    })
    await page.waitFor(1200)

    const rows = await page.$$('.bubble-row')
    const avatars = await page.$$('.bubble-avatar')
    console.log('气泡行数：' + rows.length + '，头像数：' + avatars.length)

    const headAvatar = await page.$('.chat-head-avatar')
    const headSrc = headAvatar ? await headAvatar.attribute('src') : null
    if (!check('对话页标题左侧用托蕾妮精灵形象',
      headSrc, '/assets/illustrations/elf-avatar.png')) failures++

    const srcs = []
    for (const el of avatars) srcs.push(await el.attribute('src'))
    srcs.forEach((s, i) => console.log('  头像[' + i + '] src=' + s))

    // 用户消息在第 1 行、助手在第 2 行、system 第 3 行（无头像）
    if (!check('行数与消息数一致', rows.length, 3)) failures++
    if (!check('头像数量（system 不带头像）', avatars.length, 2)) failures++
    if (srcs[0] && !check('第一行（用户）用用户头像图标',
      srcs[0], '/assets/icons/ai/icon-ai-chat-user@2x.png')) failures++
    if (srcs[1] && !check('第二行（助手）用托蕾妮头像图标',
      srcs[1], '/assets/icons/ai/icon-ai-chat@2x.png')) failures++
    if (srcs[0] && srcs[1] && !check('两侧头像不是同一张图', srcs[0] !== srcs[1], true)) failures++

    // 「我的」页头像是用户形象的另一张插画（草帽 + 抱盆栽的那位）
    await miniProgram.switchTab('/pages/profile/profile')
    const profile = await miniProgram.currentPage()
    await profile.waitFor(2500)
    const profileAvatar = await profile.$('.profile-avatar-img')
    const pSrc = profileAvatar ? await profileAvatar.attribute('src') : null
    if (!check('「我的」页头像 = 用户形象插画',
      pSrc, '/assets/illustrations/profile-avatar.png')) failures++

    // 养护历程空状态：换成场景插画
    await miniProgram.navigateTo('/pages/plant-detail/plant-detail?id=' + plantId)
    const detail = await miniProgram.currentPage()
    await detail.waitFor(3000)
    const journal = await detail.$('.journal-illustration')
    const jSrc = journal ? await journal.attribute('src') : null
    if (!check('养护历程空状态 = plant-detail-empty 插画',
      jSrc, '/assets/illustrations/plant-detail-empty.png')) failures++

  } finally {
    if (miniProgram) await miniProgram.close().catch(() => {})
    if (plantId) await deletePlant(token, plantId).catch(() => {})
  }

  console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项未通过')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
