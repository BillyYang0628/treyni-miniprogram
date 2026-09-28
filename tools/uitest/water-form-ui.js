// 实操模拟测试：添加植物页的天气模型相关字段
// 1) 土壤类型：选项 + 关键词搜索
// 2) 花盆：加仑规格下拉自动带出口径/盆高，也可手填厘米
// 3) 摆放环境：六选一，必填
// 4) 提交后落库字段正确（soil_id / exposure / pot_depth_mm / pot_diameter_mm）
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
    miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
    await miniProgram.reLaunch('/pages/garden/garden')
    await miniProgram.navigateTo('/pages/plant-form/plant-form')
    const page = await miniProgram.currentPage()
    await page.waitFor(3500)

    let data = await page.data()
    console.log(`选项加载：土壤 ${data.soilOptions.length} 种、花盆 ${data.potSpecOptions.length} 种、环境 ${data.exposureOptions.length} 种`)
    if (!check('土壤选项齐全', data.soilOptions.length >= 10, true)) failures++
    if (!check('花盆规格齐全', data.potSpecOptions.length >= 10, true)) failures++
    if (!check('摆放环境六选一', data.exposureOptions.length, 6)) failures++

    // 土壤关键词搜索
    await page.callMethod('onSoilSearchInput', { detail: { value: '颗粒土' } })
    await page.waitFor(800)
    data = await page.data()
    console.log('搜索“颗粒土”命中：' + (data.soilResults || []).map((item) => item.name).join('、'))
    if (!check('关键词能搜到颗粒土', (data.soilResults || []).some((item) => item.id === 'succulent_grit'), true)) failures++

    const soilItem = await page.$('.search-item')
    await soilItem.tap()
    await page.waitFor(600)
    data = await page.data()
    console.log('选中土壤：' + data.soil_type + '（' + data.soil_id + '）')
    if (!check('土壤已选中', data.soil_id, 'succulent_grit')) failures++
    if (!check('搜索框已清空', data.soilQuery, '')) failures++

    // 花盆规格
    const potIndex = data.potSpecOptions.findIndex((item) => item.id === 'gal_3')
    await page.callMethod('onPotSpecChange', { detail: { value: potIndex } })
    await page.waitFor(600)
    data = await page.data()
    console.log('选中花盆：' + data.pot_size + '，口径 ' + data.potDiameterCm + 'cm，盆高 ' + data.potDepthCm + 'cm')
    if (!check('自动带出盆高 235mm', data.pot_depth_mm, 235)) failures++
    if (!check('自动带出口径 245mm', data.pot_diameter_mm, 245)) failures++

    // 手填覆盖
    await page.callMethod('onInput', { currentTarget: { dataset: { field: 'potDepthCm' } }, detail: { value: '20' } })
    await page.waitFor(500)
    data = await page.data()
    console.log('手填盆高 20cm 后：' + data.pot_depth_mm + 'mm')
    if (!check('手填能覆盖规格值', data.pot_depth_mm, 200)) failures++

    // 摆放环境
    await page.callMethod('onExposureChange', { detail: { value: 1 } })
    await page.waitFor(500)
    data = await page.data()
    console.log('摆放环境：' + data.exposureOptions[data.exposureIndex].name + '（' + data.exposure + '）')
    if (!check('环境已选中', data.exposure, 'open_balcony')) failures++

    // 补全必填并提交
    await page.callMethod('onInput', { currentTarget: { dataset: { field: 'name' } }, detail: { value: '天气模型测试' } })
    await page.callMethod('onInput', { currentTarget: { dataset: { field: 'species' } }, detail: { value: '月季' } })
    await page.callMethod('onGrowthStageChange', { detail: { value: 1 } })
    await page.waitFor(600)

    await (await page.$('.btn-primary')).tap()
    await page.waitFor(3000)

    const list = await api('/plants', {}, token)
    const created = list.plants.find((item) => item.name === '天气模型测试')
    if (!check('植物已创建', Boolean(created), true)) failures++

    if (created) {
      plantId = created.id
      console.log('落库结果：' + JSON.stringify({
        soil_id: created.soil_id,
        soil_type: created.soil_type,
        exposure: created.exposure,
        pot_size: created.pot_size,
        pot_depth_mm: created.pot_depth_mm,
        pot_diameter_mm: created.pot_diameter_mm,
        growth_stage: created.growth_stage
      }))
      if (!check('土壤落库', created.soil_id, 'succulent_grit')) failures++
      if (!check('摆放环境落库', created.exposure, 'open_balcony')) failures++
      if (!check('盆高落库', created.pot_depth_mm, 200)) failures++
      if (!check('口径落库', created.pot_diameter_mm, 245)) failures++
    }

    await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'plant-form-weather.png') })
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
