// 实操模拟测试：添加植物页的品种选择与养护节奏预览
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')

const SHOT_DIR = path.resolve(__dirname, 'shots')
const ROSE_INDEX = 12 // 知识库第 13 个品种是月季

function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  return ok
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  let failures = 0

  await miniProgram.reLaunch('/pages/garden/garden')
  await miniProgram.navigateTo('/pages/plant-form/plant-form')
  const page = await miniProgram.currentPage()
  await page.waitFor(2500)

  let data = await page.data()
  console.log('品种选项数量：' + (data.speciesOptions || []).length)
  console.log('第三个选项：' + ((data.speciesOptions || [])[2] || {}).label)
  if (!check('加载到 101 个品种', (data.speciesOptions || []).length, 101)) failures++

  const option = data.speciesOptions[ROSE_INDEX]
  console.log('第 13 个选项：' + option.label)
  if (!check('第 13 个是月季', option.cn_name, '月季')) failures++

  // 模拟用户在选择器里选中月季
  await page.callMethod('onSpeciesChange', { detail: { value: ROSE_INDEX } })
  await page.waitFor(2500)

  data = await page.data()
  console.log('已选品种：' + data.species + '（' + data.speciesGroupText + '）')
  console.log('养护节奏预览：' + JSON.stringify(data.carePreview))

  if (!check('选中后自动填入品种', data.species, '月季')) failures++
  if (!check('显示栽培类型', data.speciesGroupText, '木本·观花灌木')) failures++
  if (!check('预览浇水间隔', data.carePreview && data.carePreview.watering, 2)) failures++
  if (!check('预览施肥间隔', data.carePreview && data.carePreview.fertilizing, 10)) failures++
  if (!check('预览打药间隔', data.carePreview && data.carePreview.pesticide, 15)) failures++
  if (!check('预览修剪间隔', data.carePreview && data.carePreview.pruning, 40)) failures++

  const hint = await page.$('.form-hint')
  const hintText = hint ? await hint.text() : ''
  console.log('页面提示：' + hintText.replace(/\s+/g, ' '))
  if (!check('页面上出现节奏提示', hintText.includes('浇水'), true)) failures++

  // 选择知识库品种时，手动输入框应当收起，避免出现两个品种输入控件
  const manualInput = await page.$('.form-input-gap')
  if (!check('选中知识库品种后收起手动输入', Boolean(manualInput), false)) failures++

  const toggle = await page.$('.form-toggle')
  if (!check('提供手动填写入口', Boolean(toggle), true)) failures++
  if (toggle) {
    console.log('手动填写入口文案：' + (await toggle.text()))
    await toggle.tap()
    await page.waitFor(800)
    const openedInput = await page.$('.form-input-gap')
    if (!check('点击后展开手动输入', Boolean(openedInput), true)) failures++
    await toggle.tap()
    await page.waitFor(500)
  }

  const shot = path.join(SHOT_DIR, 'plant-form-species.png')
  await miniProgram.screenshot({ path: shot })
  console.log('screenshot -> ' + shot)

  console.log(failures === 0 ? '\n全部检查通过' : '\n' + failures + ' 项检查未通过')
  await miniProgram.close()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
