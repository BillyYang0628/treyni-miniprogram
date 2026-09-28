// 插画 / 图标整合验证：把关键页面逐个截图，交给视觉模型核对图标有没有渲染出来、
// 布局有没有被图标撑坏。只做只读操作（用一盆临时植物，跑完删掉）。
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { getToken, api, deletePlant } = require('./lib')

const SHOT_DIR = path.resolve(__dirname, 'shots-art')

// 截图用的样例植物：字段填全、名字贴近真实场景。
// 早先这里用的是「插画验证」这种占位名，截出来的图既不像产品文档，
// 也会把测试残留带进公开材料里。
const FIXTURE = {
  name: '果汁阳台',
  species: '月季',
  variety: '果汁阳台',
  pot_size: '15cm 口径陶盆',
  soil_type: '泥炭 + 珍珠岩',
  location: '南向阳台',
  light_environment: '全日照',
  planting_date: '2026-08-15',
  growth_stage: '开花期',
  plant_source: '花市购买',
  pot_diameter_mm: 150,
  pot_depth_mm: 140
}

async function createFixturePlant(token) {
  const created = await api('/plants', { method: 'POST', body: FIXTURE }, token)
  return created.plant.id
}

async function shoot(miniProgram, name) {
  await miniProgram.screenshot({ path: path.join(SHOT_DIR, name + '.png') })
  const page = await miniProgram.currentPage()
  console.log('  截图 ' + name + ' <- ' + page.path)
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const token = getToken()
  let plantId = null
  let miniProgram = null

  try {
    plantId = await createFixturePlant(token)

    // 让这盆植物带上一条浇水提醒，方便截提醒详情页
    let reminderId = null
    try {
      const list = await api('/plants/' + plantId + '/reminders', {}, token)
      const first = (list.reminders || [])[0]
      if (first) reminderId = first.id
    } catch (err) {
      console.log('  取提醒失败（不影响其它截图）：' + err.message)
    }

    miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
    await miniProgram.reLaunch('/pages/garden/garden')
    await miniProgram.currentPage().then((p) => p.waitFor(2500))
    await shoot(miniProgram, '01-garden')

    await miniProgram.switchTab('/pages/profile/profile')
    await (await miniProgram.currentPage()).waitFor(2500)
    // 「我的」页底部有一块只在开发版出现的调试入口，会把本机后端地址一起截进去，
    // 所以截图前先关掉它（不改页面代码，只改这一帧的数据）。
    const profilePage = await miniProgram.currentPage()
    await profilePage.setData({ devMode: false })
    await profilePage.waitFor(400)
    await shoot(miniProgram, '02-profile')

    await miniProgram.navigateTo('/pages/plant-detail/plant-detail?id=' + plantId)
    await (await miniProgram.currentPage()).waitFor(3000)
    await shoot(miniProgram, '03-plant-detail')

    if (reminderId) {
      await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + reminderId)
      // 提醒详情里的「完整操作方案」是 AI 生成后异步填进来的，等久一点让它落定
      await (await miniProgram.currentPage()).waitFor(9000)
      await shoot(miniProgram, '04-reminder-detail')
    }

    await miniProgram.navigateTo('/pages/chat/chat?plant_id=' + plantId)
    await (await miniProgram.currentPage()).waitFor(3000)
    // 先拍一张「刚进对话页」的原始样子（只有开场白），用来和改动前对照标题里的托蕾妮形象
    await shoot(miniProgram, '05a-chat-open')

    // 造一条用户消息和一条助手消息，看两侧头像
    const chat = await miniProgram.currentPage()
    await chat.setData({
      messages: [
        { role: 'user', content: '叶子有点发黄，是不是水浇多了？', timeText: '9月16日 18:02' },
        { role: 'assistant', content: '先别急着加水。你把手指插进土里两指节，如果还是湿的，就先别浇。', timeText: '9月16日 18:02' },
        { role: 'system', content: '已执行：把浇水改成每 5 天一次', timeText: '9月16日 18:03' }
      ]
    })
    await chat.waitFor(800)
    await shoot(miniProgram, '05b-chat')

    await miniProgram.navigateTo('/pages/plant-form/plant-form')
    await (await miniProgram.currentPage()).waitFor(2500)
    await shoot(miniProgram, '06-plant-form')

    await miniProgram.navigateTo('/pages/diagnosis/diagnosis?plant_id=' + plantId + '&plant_name=' + encodeURIComponent(FIXTURE.name))
    await (await miniProgram.currentPage()).waitFor(2500)
    await shoot(miniProgram, '07-diagnosis')

    await miniProgram.navigateTo('/pages/report/report?plant_id=' + plantId + '&plant_name=' + encodeURIComponent(FIXTURE.name))
    await (await miniProgram.currentPage()).waitFor(2500)
    await shoot(miniProgram, '08-report')
  } finally {
    if (miniProgram) await miniProgram.close().catch(() => {})
    if (plantId) await deletePlant(token, plantId).catch((err) => console.log('清理失败：' + err.message))
  }

  console.log('\n截图输出目录：' + SHOT_DIR)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
