// 实操模拟测试：城市设置页面 + 提醒详情的水分账户
// 1) “我的”页显示养护位置与当地天气，点击进入城市设置
// 2) 城市搜索、选择、保存
// 3) 浇水提醒详情显示水分账户进度条、蒸发量与“降雨重置”说明
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { getToken, api, check, openDb, deletePlant } = require('./lib')

const SHOT_DIR = path.resolve(__dirname, 'shots')

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const token = getToken()
  const db = openDb()
  let failures = 0
  let plantId = null
  let miniProgram = null

  try {
    // 先造一盆会被天气模型接管的植物
    const created = await api('/plants', {
      method: 'POST',
      body: {
        name: '水分账户演示',
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
    plantId = created.plant.id
    await new Promise((resolve) => setTimeout(resolve, 3500))

    const reminders = await api('/plants/' + plantId + '/reminders', {}, token)
    const watering = reminders.reminders.find((item) => item.type === 'watering')

    miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })

    // 1) 我的页
    await miniProgram.switchTab('/pages/profile/profile')
    let page = await miniProgram.currentPage()
    await page.waitFor(3500)

    let data = await page.data()
    console.log('养护位置：' + (data.location ? data.location.city : '未设置'))
    if (data.weather) {
      console.log('当地天气：' + data.weather.now.text + ' ' + data.weather.now.temp + '℃ 湿度 ' + data.weather.now.humidity + '%')
    } else {
      console.log('天气：' + (data.weatherError || '加载中'))
    }

    if (!check('已显示养护位置', Boolean(data.location && data.location.city), true)) failures++
    if (!check('已显示当地天气', Boolean(data.weather), true)) failures++

    await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'profile-location.png') })

    // 2) 城市设置页
    await (await page.$('.location-card')).tap()
    await page.waitFor(2500)
    page = await miniProgram.currentPage()
    if (!check('进入城市设置页', page.path, 'pages/city/city')) failures++

    await page.setData({ keyword: '成都' })
    await page.callMethod('onSearch')
    await page.waitFor(2500)
    data = await page.data()
    console.log('搜索“成都”命中：' + (data.cities || []).map((c) => c.name + '(' + c.id + ')').join('、'))
    if (!check('城市搜索有结果', (data.cities || []).length > 0, true)) failures++

    await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'city-search.png') })

    // 选第一个候选（成都），保存后返回
    const item = await page.$('.city-item')
    await item.tap()
    await page.waitFor(2500)
    page = await miniProgram.currentPage()
    data = await page.data()
    console.log('保存后回到：' + page.path + '，当前城市：' + (data.location ? data.location.city : '—'))
    if (!check('城市已改为成都', data.location && data.location.city, '成都')) failures++

    // 3) 浇水提醒详情的水分账户
    await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + watering.id)
    page = await miniProgram.currentPage()
    await page.waitFor(3000)
    data = await page.data()

    console.log('提醒详情 water：' + JSON.stringify(data.water))
    if (!check('详情返回水分账户', Boolean(data.water), true)) failures++
    if (data.water) {
      console.log('账户剩余：' + data.waterPercentText + '，蒸发量：' + data.waterEt0Text)
      console.log('来源提示：' + data.detailSourceText)
      if (!check('展示剩余水量', data.waterPercentText.length > 0, true)) failures++
      if (!check('展示蒸发量', data.waterEt0Text.length > 0, true)) failures++
    }

    const bar = await page.$('.water-bar-inner')
    if (!check('渲染水分进度条', Boolean(bar), true)) failures++

    await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'water-reminder-detail.png') })

    // 把城市改回上海，避免影响后续测试
    await api('/users/me/location', { method: 'PUT', body: { city: '上海' } }, token)
  } finally {
    if (miniProgram) await miniProgram.close().catch(() => {})
    if (plantId) {
      await deletePlant(token, plantId).catch((err) => console.log('清理失败：' + err.message))
      const left = db.prepare('SELECT COUNT(*) AS c FROM plant_reminders WHERE plant_id = ?').get(plantId).c
      console.log('清理临时植物：剩余提醒 ' + left + ' 条')
      if (!check('临时数据已清理', left, 0)) failures++
    }
    db.close()
  }

  console.log(failures === 0 ? '\n全部检查通过' : '\n' + failures + ' 项检查未通过')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
