// 校验提醒详情页把"方案已生成"这类成功提示从居中 toast 改成了页内提示：
//   1) 重新生成后出现页内提示（noticeText），且页面上有对应的元素
//   2) 提示不会长时间停留（约 2.6 秒后自动消失）
//   3) 提示出现时，头部卡片等正文元素依然可见（不再被遮住）
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
  let plantId = null
  let mp = null

  try {
    const plant = await api('/plants', {
      method: 'POST',
      body: {
        name: '提示验收月季',
        species: '月季',
        growth_stage: '中苗',
        exposure: 'outdoor',
        soil_id: 'peat_mix',
        soil_type: '通用营养土（泥炭混合）',
        pot_size: '3 加仑',
        pot_depth_mm: 235,
        pot_diameter_mm: 245
      }
    }, token)
    plantId = plant.plant.id
    await new Promise((r) => setTimeout(r, 3000))

    const reminders = (await api('/plants/' + plantId + '/reminders', {}, token)).reminders
    const fert = reminders.find((r) => r.type === 'fertilizing')

    mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
    await mp.reLaunch('/pages/garden/garden')
    let page = await mp.currentPage()
    await page.waitFor(2000)
    await mp.navigateTo('/pages/reminder-detail/reminder-detail?id=' + fert.id)
    page = await mp.currentPage()
    await page.waitFor(3000)

    check('初始没有提示', (await page.data()).noticeText, '')

    // 先 mock 掉意见弹窗（直接返回确认 + 一段意见），再触发重新生成
    await mp.mockWxMethod('showModal', { confirm: true, content: '家里没有喷壶' })
    await page.callMethod('onRegenerate')
    await page.waitFor(2000)

    // 等生成完成（出现页内提示）
    const deadline = Date.now() + 180000
    let noticed = null
    while (Date.now() < deadline) {
      const data = await page.data()
      if (!data.generating && data.noticeText) { noticed = data; break }
      if (!data.generating && data.error) break
      await page.waitFor(3000)
    }
    await mp.restoreWxMethod('showModal').catch(() => {})

    if (!noticed) {
      const data = await page.data()
      check('生成后出现页内提示', data.noticeText || '（无）', '方案已更新')
      check('生成未报错', data.error || '', '')
    } else {
      check('生成后出现页内提示', noticed.noticeText, '方案已更新')
      const noticeNode = await page.$('.inline-notice')
      check('页面上渲染出提示元素', Boolean(noticeNode), true)
      const headCard = await page.$('.head-card')
      check('正文卡片仍可见（提示不遮挡内容）', Boolean(headCard), true)
      await mp.screenshot({ path: path.join(SHOT_DIR, 'fix-inline-notice.png') }).catch(() => {})

      // 提示应在 2.6 秒左右自动消失
      await page.waitFor(3200)
      const after = await page.data()
      check('提示会自动消失', after.noticeText, '')
    }
  } finally {
    if (plantId) await api('/plants/' + plantId, { method: 'DELETE' }, token).catch(() => {})
    if (plantId) {
      const left = db.prepare('SELECT COUNT(*) AS c FROM plant_reminders WHERE plant_id = ?').get(plantId).c
      console.log('清理临时植物 ' + plantId + '，剩余提醒 ' + left + ' 条')
      if (left !== 0) failures++
    }
    db.close()
    if (mp) await mp.close().catch(() => {})
  }

  console.log(failures === 0 ? '\n全部检查通过' : '\n' + failures + ' 项检查未通过')
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exitCode = 1
})
