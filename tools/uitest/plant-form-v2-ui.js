// 实操模拟测试：添加植物页三项改进
// 1) 品种关键词搜索
// 2) 花盆大小说明入口（种植条件速查）
// 3) 输入框占位文字在聚焦前后位置稳定
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')

const SHOT_DIR = path.resolve(__dirname, 'shots')

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
  await page.waitFor(3000)

  // 1) 关键词搜索
  const searchInput = await page.$('.search-input')
  if (!check('有品种搜索框', Boolean(searchInput), true)) failures++

  await page.callMethod('onSearchInput', { detail: { value: '月季' } })
  await page.waitFor(1000)
  let data = await page.data()
  console.log('搜索“月季”命中：' + (data.speciesResults || []).map((item) => item.cn_name).join('、'))
  if (!check('搜索有结果', (data.speciesResults || []).length > 0, true)) failures++
  if (!check('命中月季', (data.speciesResults || []).some((item) => item.cn_name === '月季'), true)) failures++

  // 别名搜索
  await page.callMethod('onSearchInput', { detail: { value: '微型' } })
  await page.waitFor(800)
  data = await page.data()
  console.log('搜索“微型”命中：' + (data.speciesResults || []).map((item) => item.cn_name).join('、'))
  if (!check('别名也能搜到', (data.speciesResults || []).length > 0, true)) failures++

  await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'plant-form-search.png') })

  // 点选结果
  const firstItem = await page.$('.search-item')
  await firstItem.tap()
  await page.waitFor(2500)
  data = await page.data()
  console.log('点选后品种：' + data.species + '，搜索结果已清空：' + (data.speciesResults.length === 0))
  if (!check('点选结果填入品种', data.species.length > 0, true)) failures++
  if (!check('点选后收起结果列表', data.speciesResults.length, 0)) failures++
  if (!check('显示养护节奏预览', Boolean(data.carePreview), true)) failures++

  // 3) 输入框聚焦前后尺寸一致（占位文字不跳动）
  const nameInput = await page.$('.form-input')
  const beforeBox = await nameInput.size()
  await nameInput.tap()
  await page.waitFor(800)
  const afterBox = await nameInput.size()
  console.log('聚焦前高度 ' + Math.round(beforeBox.height) + 'px，聚焦后 ' + Math.round(afterBox.height) + 'px')
  if (!check('聚焦前后输入框高度不变', Math.round(beforeBox.height), Math.round(afterBox.height))) failures++

  await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'plant-form-focus.png') })

  // 2) 花盆说明入口
  const link = await page.$('.form-link')
  if (!check('有花盆大小说明入口', Boolean(link), true)) failures++
  console.log('入口文案：' + (await link.text()))
  await link.tap()
  await page.waitFor(2500)

  const guidePage = await miniProgram.currentPage()
  if (!check('打开种植条件速查', guidePage.path, 'pages/care-guide/care-guide')) failures++

  const guide = await guidePage.data()
  console.log('速查页标题：' + guide.title + '，折叠卡片 ' + guide.groups.length + ' 张')
  if (!check('打开的是花盆大小', guide.activeKey, 'pot_size')) failures++
  if (!check('内容非空', guide.blocks.length > 10, true)) failures++
  if (!check('按知识点折叠成多张卡片', guide.groups.length > 3, true)) failures++
  if (!check('默认只展开第一张', guide.groups[0].open, true)) failures++
  if (!check('后面的是收起状态', guide.groups[1].open, false)) failures++

  const collapsedRows = await guidePage.$$('.table-row')
  console.log('收起状态下渲染的表格行数：' + collapsedRows.length)
  if (!check('收起时不渲染表格，页面才短', collapsedRows.length, 0)) failures++

  const heads = await guidePage.$$('.group-head')
  console.log('折叠卡片标题：' + (await Promise.all(heads.slice(0, 4).map((h) => h.text()))).map((t) => t.replace(/\s+/g, ' ')).join(' | '))

  // 展开“加仑盆常见规格对照表”（第 3 张卡片）
  await heads[2].tap()
  await guidePage.waitFor(1200)
  const expanded = await guidePage.data()
  if (!check('点击后展开对应卡片', expanded.groups[2].open, true)) failures++

  const tableRows = await guidePage.$$('.table-row')
  console.log('展开后的表格行数：' + tableRows.length)
  if (!check('展开后渲染规格表', tableRows.length > 0, true)) failures++

  await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'care-guide-pot.png') })

  // 全部收起 / 全部展开
  await (await guidePage.$('.guide-toggle')).tap()
  await guidePage.waitFor(1200)
  const allOpen = await guidePage.data()
  console.log('点“全部展开”后：' + allOpen.groups.filter((g) => g.open).length + ' 张展开')
  if (!check('全部展开生效', allOpen.groups.every((g) => g.open), true)) failures++

  // 四个字段各自有独立入口，页面内不再有版块切换
  const tabRow = await guidePage.$('.tab-row')
  if (!check('页面内不再有版块切换标签', Boolean(tabRow), false)) failures++

  await miniProgram.navigateBack()
  await page.waitFor(1500)

  const links = await page.$$('.form-link')
  console.log('字段详情入口数量：' + links.length)
  if (!check('四个字段各有一个入口', links.length, 4)) failures++

  for (let i = 0; i < links.length; i++) {
    const text = (await links[i].text()).replace(/\s+/g, ' ')
    console.log(`  入口 ${i + 1}：${text}`)
  }

  // 校验每个入口打开的是各自版块
  const expected = ['pot_size', 'soil_type', 'location', 'light_environment']
  for (let i = 0; i < links.length; i++) {
    const currentLinks = await page.$$('.form-link')
    await currentLinks[i].tap()
    await page.waitFor(2000)

    const target = await miniProgram.currentPage()
    const targetData = await target.data()
    console.log(`  入口 ${i + 1} → ${targetData.title}（${targetData.activeKey}）`)
    if (!check('入口 ' + (i + 1) + ' 打开对应版块', targetData.activeKey, expected[i])) failures++
    if (!check('入口 ' + (i + 1) + ' 有内容', targetData.groups.length > 0, true)) failures++

    await miniProgram.navigateBack()
    await page.waitFor(1200)
  }

  console.log(failures === 0 ? '\n全部检查通过' : '\n' + failures + ' 项检查未通过')
  await miniProgram.close()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
