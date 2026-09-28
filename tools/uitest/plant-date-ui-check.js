// 校验"开始养护日期"这个字段的界面改动：
// 1) 文案改成"开始养护日期（选填）"，并说明填到手日期即可
// 2) 可以先选日期，再点"清除日期"恢复为空
// 3) 不填日期也能正常保存
const automator = require('miniprogram-automator')
const { getToken, api, openDb } = require('./lib')

let failures = 0

function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (!ok) failures++
}

async function main() {
  const token = getToken()
  const db = openDb()
  let plantId = null
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })

  try {
    await mp.reLaunch('/pages/garden/garden')
    let page = await mp.currentPage()
    await page.waitFor(2000)
    await mp.navigateTo('/pages/plant-form/plant-form')
    page = await mp.currentPage()
    await page.waitFor(3500)

    // 1) 文案
    const labels = await page.$$('.form-label')
    const labelTexts = []
    for (const node of labels) labelTexts.push((await node.text()).trim())
    console.log('表单字段：' + labelTexts.join(' / '))
    check('字段名已改为“开始养护日期（选填）”', labelTexts.includes('开始养护日期（选填）'), true)
    check('不再出现“种下日期”', labelTexts.includes('种下日期'), false)

    const hints = await page.$$('.form-hint-plain')
    const hintTexts = []
    for (const node of hints) hintTexts.push((await node.text()).trim())
    const dateHint = hintTexts.find((t) => t.includes('开始养它')) || ''
    console.log('日期提示：' + dateHint)
    check('提示说明填到手日期即可', /到手/.test(dateHint), true)
    check('提示说明可以不填', /不用填|可以不填/.test(dateHint), true)

    // 2) 选日期后出现"清除"，点一下恢复为空
    await page.callMethod('onDateChange', { detail: { value: '2026-09-01' } })
    await page.waitFor(800)
    let data = await page.data()
    check('选择日期后写入字段', data.planting_date, '2026-09-01')
    const clearLink = await page.$('.form-link')
    const linkTexts = []
    for (const node of await page.$$('.form-link')) linkTexts.push((await node.text()).trim())
    check('出现“清除日期”入口', linkTexts.some((t) => t.includes('清除日期')), true)

    await page.callMethod('onClearDate')
    await page.waitFor(600)
    data = await page.data()
    check('清除后字段为空', data.planting_date, '')
    if (!clearLink) console.log('备注 | 清除入口为条件渲染，清除后消失属正常')

    // 3) 不填日期直接保存
    const name = '选填日期验收' + Date.now() % 100000
    await page.callMethod('onInput', { currentTarget: { dataset: { field: 'name' } }, detail: { value: name } })
    await page.callMethod('onPickSpecies', { currentTarget: { dataset: { id: '月季' } } })
    await page.callMethod('onGrowthStageChange', { detail: { value: '1' } })
    await page.callMethod('onExposureChange', { detail: { value: '0' } })
    await page.waitFor(1000)
    await page.callMethod('onSubmit')
    await page.waitFor(3000)

    const list = await api('/plants', {}, token)
    const created = (list.plants || []).find((p) => p.name === name)
    check('不填日期也能保存成功', Boolean(created), true)
    if (created) {
      plantId = created.id
      check('落库后开始养护日期为空', created.planting_date || '', '')
    }
  } finally {
    if (plantId) await api('/plants/' + plantId, { method: 'DELETE' }, token).catch(() => {})
    if (plantId) {
      const left = db.prepare('SELECT COUNT(*) AS c FROM plant_reminders WHERE plant_id = ?').get(plantId).c
      console.log('清理临时植物 ' + plantId + '，剩余提醒 ' + left + ' 条')
      if (left !== 0) failures++
    }
    db.close()
    await mp.close().catch(() => {})
  }

  console.log(failures === 0 ? '\n全部检查通过' : '\n' + failures + ' 项检查未通过')
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exitCode = 1
})
