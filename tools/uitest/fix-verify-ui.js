// 本轮修正的模拟器验收：
// 1) 浇水折中系数：沙质土 + 小盆 + 露养会让天气模型与知识库差得很大，详情页要显示折中说明
// 2) 缓苗期：刚移栽的植物，施肥提醒要顺延并在详情页给出缓苗期提示
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { getToken, api, openDb } = require('./lib')

const SHOT_DIR = path.resolve(__dirname, 'shots')
let failures = 0

function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (!ok) failures++
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const token = getToken()
  const db = openDb()
  const created = []
  let mp = null

  try {
    // 1) 折中系数：沙质土（w=0.18）+ 0.5 加仑小盆 + 露养
    const fast = await api('/plants', {
      method: 'POST',
      body: {
        name: '折中系数验收',
        species: '月季',
        growth_stage: '中苗',
        is_recent_transplant: 0,
        exposure: 'outdoor',
        soil_id: 'sandy',
        soil_type: '沙质土',
        pot_size: '0.5 加仑',
        pot_depth_mm: 110,
        pot_diameter_mm: 120
      }
    }, token)
    created.push(fast.plant.id)

    // 2) 缓苗期：刚移栽
    const rest = await api('/plants', {
      method: 'POST',
      body: {
        name: '缓苗期验收',
        species: '月季',
        growth_stage: '小苗',
        plant_source: '网购',
        is_recent_transplant: 1,
        exposure: 'open_balcony',
        soil_id: 'peat_mix',
        soil_type: '通用营养土（泥炭混合）',
        pot_size: '1 加仑',
        pot_depth_mm: 160,
        pot_diameter_mm: 175
      }
    }, token)
    created.push(rest.plant.id)

    await new Promise((r) => setTimeout(r, 4000))

    const fastReminders = await api('/plants/' + fast.plant.id + '/reminders', {}, token)
    const fastWater = (fastReminders.reminders || []).find((r) => r.type === 'watering')
    const restReminders = await api('/plants/' + rest.plant.id + '/reminders', {}, token)
    const restFert = (restReminders.reminders || []).find((r) => r.type === 'fertilizing')
    const restFertDetail = await api('/reminders/' + restFert.id, {}, token)

    console.log('折中验收植物浇水提醒：' + fastWater.summary_text)
    console.log('  water meta=' + JSON.stringify(fastWater.meta && fastWater.meta.water))
    check('沙质土小盆触发折中', Boolean(fastWater.meta && fastWater.meta.water && fastWater.meta.water.corrected), true)

    mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })

    // 浇水详情页的折中说明
    await mp.reLaunch('/pages/garden/garden')
    let page = await mp.currentPage()
    await page.waitFor(2000)
    await mp.navigateTo('/pages/reminder-detail/reminder-detail?id=' + fastWater.id)
    page = await mp.currentPage()
    await page.waitFor(3500)
    let data = await page.data()
    console.log('详情页折中说明：' + data.waterCorrectText)
    check('详情页显示折中说明', data.waterCorrectText.length > 0, true)
    check('折中说明含两种口径', /天气模型算出每/.test(data.waterCorrectText) && /知识库标准是每/.test(data.waterCorrectText), true)
    const rows = await page.$$('.water-row')
    check('水分卡片渲染出折中行', rows.length >= 4, true)
    await mp.screenshot({ path: path.join(SHOT_DIR, 'fix-water-correction.png') })

    // 缓苗期：植物详情列表 + 施肥提醒详情
    await mp.navigateBack()
    await page.waitFor(1500)
    await mp.navigateTo('/pages/plant-detail/plant-detail?id=' + rest.plant.id)
    page = await mp.currentPage()
    await page.waitFor(3500)
    data = await page.data()
    const fertItem = (data.reminders || []).find((r) => r.type === 'fertilizing')
    console.log('缓苗期植物施肥提醒摘要：' + (fertItem && fertItem.summary_text))
    check('列表摘要提到缓苗期', /缓苗期/.test((fertItem && fertItem.summary_text) || ''), true)
    await mp.screenshot({ path: path.join(SHOT_DIR, 'fix-rest-list.png') })

    await mp.navigateTo('/pages/reminder-detail/reminder-detail?id=' + restFert.id)
    page = await mp.currentPage()
    await page.waitFor(3000)
    data = await page.data()
    console.log('施肥提醒详情提示：' + data.restText)
    check('详情页显示缓苗期提示', /缓苗期/.test(data.restText || ''), true)
    const restNode = await page.$('.head-rest')
    check('缓苗期提示已渲染', Boolean(restNode), true)
    check('详情正文含先不施肥说明', /先不要施肥/.test(data.detailText || ''), true)
    await mp.screenshot({ path: path.join(SHOT_DIR, 'fix-rest-detail.png') })

    check('缓苗期提醒带缓苗标记', Boolean(restFertDetail.reminder && restFertDetail.reminder.meta && restFertDetail.reminder.meta.rest === 'transplant'), true)
  } catch (err) {
    console.error('FAILED: ' + err.message)
    failures++
  } finally {
    if (mp) await mp.close().catch(() => {})
    for (const id of created) {
      await api('/plants/' + id, { method: 'DELETE' }, token).catch(() => {})
    }
    const left = created.length
      ? db.prepare(`SELECT COUNT(*) AS c FROM plant_reminders WHERE plant_id IN (${created.join(',')})`).get().c
      : 0
    console.log('清理临时植物 ' + created.length + ' 盆，剩余提醒 ' + left + ' 条')
    if (left !== 0) failures++
    db.close()
  }

  console.log(failures === 0 ? '\n全部检查通过' : '\n' + failures + ' 项检查未通过')
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack)
  process.exitCode = 1
})
