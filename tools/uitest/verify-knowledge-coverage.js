/**
 * 知识库覆盖率回归（C-1）。只查数据，不调 AI、不起开发者工具。
 *
 * 为什么要有这个脚本：
 *   以前「病虫害名 → 档案」和「药名 → 药剂档案」这两层全靠 name 字段精确/包含匹配，
 *   结果 101 个品种里有 38 个（44 个病虫害名）查不到档案——诊断出这些名字时，
 *   用药指导提示词里整段「病虫害用药库」会消失，模型只能凭常识发挥。
 *   加品种、加药、改别名都可能再把这个洞打开，而且不会报错，所以写成断言。
 *
 * 七组：
 *   ① 品种速查表里的病虫害名全部能解析到档案
 *   ② 病虫害档案的 aliases 双向一致、彼此不冲突
 *   ③ 病虫害档案三档方案齐全（prevention / mild / severe）
 *   ④ 药剂档案自洽：正式名能解析回自己（防子串误配）
 *   ⑤ 速查表 / 病害档案里提到的药名都能解析到药剂档案
 *   ⑥ 药剂条目字段完整（toxicity 允许「未核实」，但必须写明 data_pending）
 *   ⑦ 购买指南里 X 系列缺口标记与药剂档案现状一致
 *
 * 用法：node verify-knowledge-coverage.js
 */
const path = require('node:path')
const { SERVER_DIR, loadEnv, check, checkTruthy, summary } = require('./ai-lib')

loadEnv()
const knowledge = require(path.join(SERVER_DIR, 'src/services/knowledge.js'))

function main() {
  const plants = knowledge.loadPlants()
  const pesticide = knowledge.loadPesticide()
  const diseases = knowledge.loadPesticideDiseases()
  const { drugs } = knowledge.loadPesticideDrugs()

  const plantNames = Object.keys(plants)
  const drugList = Object.values(drugs)

  console.log('=== ① 品种速查表里的病虫害名 → 档案 ===')
  let checked = 0
  const unresolved = []
  for (const name of plantNames) {
    const entry = pesticide[name] || {}
    const names = [
      ...((entry.targets || []).map((t) => t.name)),
      ...(entry.common_pests || [])
    ].filter(Boolean)
    for (const pestName of names) {
      checked++
      if (!knowledge.findDisease(pestName)) unresolved.push(name + '/' + pestName)
    }
  }
  console.log('  检查 ' + checked + ' 个（品种 × 病虫害名）组合')
  check('病虫害名全部能解析到档案',
    unresolved.length ? unresolved.slice(0, 8).join('；') + (unresolved.length > 8 ? ' …共' + unresolved.length : '') : '（无缺失）',
    '（无缺失）')

  console.log('')
  console.log('=== ② aliases 双向一致、不冲突 ===')
  const owner = {}
  const conflicts = []
  const mismatched = []
  for (const [code, item] of Object.entries(diseases)) {
    for (const alias of item.aliases || []) {
      if (owner[alias] && owner[alias] !== code) conflicts.push(alias + '：' + owner[alias] + ' vs ' + code)
      owner[alias] = code
      const hit = knowledge.findDisease(alias)
      if (!hit || hit.code !== code) mismatched.push(alias + ' → ' + (hit ? hit.code : 'null') + '（应为 ' + code + '）')
    }
  }
  console.log('  别名总数 ' + Object.keys(owner).length + ' 个')
  check('别名都解析回自己那条档案', mismatched.length ? mismatched.join('；') : '（全部一致）', '（全部一致）')
  check('别名没有一物两名（不同档案抢同一个别名）', conflicts.length ? conflicts.join('；') : '（无冲突）', '（无冲突）')

  console.log('')
  console.log('=== ③ 病虫害档案三档方案齐全 ===')
  const incomplete = []
  for (const [code, item] of Object.entries(diseases)) {
    const stages = item.stages || {}
    const missing = ['prevention', 'mild', 'severe'].filter((stage) => {
      const plan = stages[stage]
      return !plan || (!plan.a && !plan.b)
    })
    if (missing.length) incomplete.push(code + ' 缺 ' + missing.join('/'))
  }
  check(diseases && Object.keys(diseases).length + ' 条档案都齐 prevention/mild/severe',
    incomplete.length ? incomplete.join('；') : '（都齐）', '（都齐）')

  console.log('')
  console.log('=== ④ 药剂档案自洽（防子串误配）===')
  const wrong = []
  for (const [code, drug] of Object.entries(drugs)) {
    const hit = knowledge.findDrug(drug.name)
    if (!hit) wrong.push(drug.name + ' → null')
    else if (hit.code !== code) wrong.push(drug.name + ' → ' + hit.code + '（应为 ' + code + '）')
  }
  console.log('  药剂档案 ' + drugList.length + ' 条')
  check('正式药名都解析回自己', wrong.length ? wrong.join('；') : '（全部正确）', '（全部正确）')

  console.log('')
  console.log('=== ⑤ 速查表 / 病害档案里提到的药名 → 药剂档案 ===')
  // 有些方案句子里会出现肥料（例如 P15 的「均衡水溶肥 2000 倍」），
  // 那不是药剂，不能拿药剂档案去要求它。先把肥料名挑出来跳过。
  const fertNames = []
    .concat(Object.values(knowledge.loadFertilizingProducts().products || {})
      .flatMap((group) => (group.items || []).map((row) => row[0])))
    .concat((knowledge.loadPurchaseGuide().fertilizers || []).map((f) => f.name))
    .filter(Boolean)
  // 「均衡水溶肥」这种通用说法不在商品清单里，所以再补一层关键词判断
  const FERT_KEYWORDS = ['水溶肥', '缓释肥', '复合肥', '有机肥', '叶面肥', '营养液', '专用肥',
    '菌剂', '生根粉', '芸苔素', '肥料', '磷酸二氢钾', '尿素']
  // 只在「它确实不是药剂档案里的药」时才跳——枯草芽孢杆菌既是菌剂也是药剂（D37），
  // 这种双重身份的名字要留在断言里，别被当成肥料跳过。
  const isFertilizer = (token) => {
    if (knowledge.findDrug(token)) return false
    return fertNames.some((n) => String(n).includes(token) || token.includes(String(n))) ||
      FERT_KEYWORDS.some((word) => token.includes(word))
  }
  const mentioned = new Set()
  const skippedAsFertilizer = new Set()
  const scan = (text) => {
    for (const clause of String(text || '').split(/[；;]/)) {
      if (!/倍|波美度/.test(clause)) continue
      const m = clause.match(/([\u4e00-\u9fa5A-Za-z0-9·（）()]{2,20})\s*\d+[\d–\-~]*\s*倍/)
      if (!m) continue
      const token = m[1]
        .replace(/^缺[\u4e00-\u9fa5]{1,2}用/, '')
        .replace(/^(用|喷|改用|换用|可用|选|如|例如|注意|稀释|按|加|兑|与|和)/, '')
      if (!token) continue
      if (isFertilizer(token)) skippedAsFertilizer.add(token)
      else mentioned.add(token)
    }
  }
  for (const name of plantNames) {
    const entry = pesticide[name] || {}
    for (const t of entry.targets || []) {
      for (const field of ['prevention', 'mild', 'severe', 'alternative']) scan(t[field])
    }
  }
  for (const item of Object.values(diseases)) {
    for (const plan of Object.values(item.stages || {})) {
      scan(plan.a)
      scan(plan.b)
    }
  }
  const drugMiss = []
  for (const token of mentioned) {
    if (!knowledge.findDrug(token)) drugMiss.push(token)
  }
  console.log('  提到 ' + mentioned.size + ' 个药名候选')
  if (skippedAsFertilizer.size) {
    console.log('  跳过 ' + skippedAsFertilizer.size + ' 个肥料名（不是药剂）：' + [...skippedAsFertilizer].join('、'))
  }
  check('提到的药名都能解析到药剂档案',
    drugMiss.length ? drugMiss.join('；') : '（无缺失）',
    '（无缺失）')

  console.log('')
  console.log('=== ⑥ 药剂条目字段完整 ===')
  const fieldMiss = []
  for (const [code, drug] of Object.entries(drugs)) {
    for (const field of ['code', 'name', 'dilution', 'interval', 'targets', 'group']) {
      if (!drug[field]) fieldMiss.push(code + '.' + field)
    }
    // toxicity 允许写「未核实」，但必须同时有 data_pending 说明缺什么
    if (!drug.toxicity) fieldMiss.push(code + '.toxicity')
    if (String(drug.toxicity || '').includes('未核实') && !(drug.data_pending || []).length) {
      fieldMiss.push(code + '.data_pending（toxicity 未核实却没写待办）')
    }
  }
  check('字段齐全，未核实的都写了待办',
    fieldMiss.length ? fieldMiss.slice(0, 8).join('；') : '（齐全）',
    '（齐全）')

  console.log('')
  console.log('=== ⑦ 购买指南的缺口标记与药剂档案现状一致 ===')
  const guide = knowledge.loadPurchaseGuide()
  const guideItems = Object.values(guide.items || {})
  const marked = guideItems.filter((item) => item.drug_record_missing)
  const actuallyMissing = guideItems.filter((item) => !knowledge.findDrug(item.name))
  const stillMissing = marked.filter((item) => !knowledge.findDrug(item.name))
  console.log('  标了 drug_record_missing 的：' + marked.length + ' 条' +
    (marked.length ? '（' + marked.map((i) => i.name).join('、') + '）' : ''))
  console.log('  实际查不到药剂档案的：' + actuallyMissing.length + ' 条' +
    (actuallyMissing.length ? '（' + actuallyMissing.map((i) => i.name).join('、') + '）' : '') +
    '  ← 2026-09-21 的 7 个缺口已补成 D40-D46')
  // 断言的意义是「标记不会过期」：两边必须同时为 0，或同时非 0
  check('标记数与实际缺口数一致', marked.length, actuallyMissing.length)
  check('标了缺档的确实还查不到',
    stillMissing.length ? stillMissing.map((i) => i.name).join('、') : '（一致）', '（一致）')

  process.exit(summary() > 0 ? 1 : 0)
}

try {
  main()
} catch (err) {
  console.error('FAILED:', (err && err.stack) || err)
  process.exit(1)
}
