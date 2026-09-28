// 作品集截图：用一个独立的「演示账号」拍花园页 / 植物详情 / 提醒详情。
//
// 为什么不直接用开发账号：开发账号的花园里积了几个月的历史测试植物
// （名字是占位符、照片是随手传的），截进公开材料里既不像产品文档，也泄露私人数据。
// 演示账号只放三盆字段填全的样例植物，拍完连同账号一起删掉。
//
// 只读之外只做两件事：临时建演示账号 + 临时建样例植物，结束时全部清理。
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { api, openDb } = require('./lib')
const { createToken } = require('../../server/src/services/token')

const SHOT_DIR = path.resolve(__dirname, 'shots-art')
const DEMO_OPENID = 'demo:portfolio'

const PLANTS = [
  {
    name: '果汁阳台', species: '月季', variety: '果汁阳台',
    pot_size: '15cm 口径陶盆', soil_type: '泥炭 + 珍珠岩', location: '南向阳台',
    light_environment: '全日照', planting_date: '2026-08-15', growth_stage: '开花期',
    plant_source: '花市购买', pot_diameter_mm: 150, pot_depth_mm: 140
  },
  {
    name: '龟背竹', species: '龟背竹', variety: '大叶龟背竹',
    pot_size: '20cm 口径塑料盆', soil_type: '通用营养土', location: '客厅窗边',
    light_environment: '明亮散射光', planting_date: '2026-05-02', growth_stage: '生长期',
    plant_source: '网购', pot_diameter_mm: 200, pot_depth_mm: 180
  },
  {
    name: '玉露', species: '多肉', variety: '玉露',
    pot_size: '8cm 红陶小盆', soil_type: '颗粒土', location: '书桌',
    light_environment: '半日照', planting_date: '2026-06-20', growth_stage: '生长期',
    plant_source: '朋友赠送', pot_diameter_mm: 80, pot_depth_mm: 70
  }
]

async function shoot(miniProgram, name) {
  await miniProgram.screenshot({ path: path.join(SHOT_DIR, name + '.png') })
  const page = await miniProgram.currentPage()
  console.log('  截图 ' + name + ' <- ' + page.path)
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const db = openDb()
  let userId = null
  let createdUser = false
  const plantIds = []
  let miniProgram = null

  try {
    const found = db.prepare('SELECT id FROM users WHERE openid = ?').get(DEMO_OPENID)
    if (found) {
      userId = found.id
    } else {
      userId = Number(
        db.prepare('INSERT INTO users (openid, nickname) VALUES (?, ?)').run(DEMO_OPENID, '演示账号')
          .lastInsertRowid
      )
      createdUser = true
    }
    const token = createToken(userId)

    for (const plant of PLANTS) {
      const created = await api('/plants', { method: 'POST', body: plant }, token)
      plantIds.push(created.plant.id)
    }
    console.log('演示账号 id=' + userId + '，样例植物 ' + plantIds.join(', '))

    miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
    // 把客户端切到演示账号：注入 token 后重进首页
    await miniProgram.callWxMethod('setStorageSync', 'token', token)
    await miniProgram.callWxMethod('setStorageSync', 'userInfo', { nickname: '演示账号' })
    await miniProgram.reLaunch('/pages/garden/garden')
    await (await miniProgram.currentPage()).waitFor(3500)
    await shoot(miniProgram, 'p1-garden')

    await miniProgram.navigateTo('/pages/plant-detail/plant-detail?id=' + plantIds[0])
    await (await miniProgram.currentPage()).waitFor(3500)
    await shoot(miniProgram, 'p2-plant-detail')

    const list = await api('/plants/' + plantIds[0] + '/reminders', {}, token)
    const first = (list.reminders || [])[0]
    if (first) {
      await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + first.id)
      await (await miniProgram.currentPage()).waitFor(9000)
      await shoot(miniProgram, 'p3-reminder-detail')
    } else {
      console.log('  这盆植物没有提醒，跳过提醒详情页')
    }
  } finally {
    if (miniProgram) await miniProgram.close().catch(() => {})
    const cleanupToken = userId ? createToken(userId) : ''
    for (const id of plantIds) {
      await api('/plants/' + id, { method: 'DELETE' }, cleanupToken).catch((err) =>
        console.log('  清理植物失败：' + err.message)
      )
    }
    if (createdUser) {
      db.prepare('DELETE FROM users WHERE id = ?').run(userId)
      console.log('演示账号已删除')
    } else if (userId) {
      console.log('演示账号本来就是复用的，保留 id=' + userId)
    }
    db.close()
  }

  console.log('\n截图输出目录：' + SHOT_DIR)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
