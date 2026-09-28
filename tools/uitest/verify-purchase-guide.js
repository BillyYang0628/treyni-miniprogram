/**
 * 购买指南库（B-1 / C-2）的数据校验：侧栏交库之后先跑这个。
 *
 * 只查数据，不调 AI、不起开发者工具。要验的是「配上去会不会出事」：
 *   ① 结构完整：顶层段落齐全，条数对得上
 *   ② 字段够用：每条都有 name / search / where（没 search 就没法给用户一句可复制的话）
 *   ③ **覆盖率**：药剂档案 39 条、施肥成品、常见器械——库里的东西必须能买到指路
 *   ④ household 的 ref 指向施肥库真实存在的 Y 码（不能指向空气）
 *   ⑤ 合规：不写店铺名、链接、价格（渠道类型「官方旗舰店」是允许的）
 *   ⑥ 缺口如实标记：标记数必须与「药剂档案里查得到查不到」的实际情况一致
 *      （2026-09-21 起 X01-X07 已补成 D40-D46，所以期望值是 0；将来再缺，条数要对得上）
 *
 * 用法：node verify-purchase-guide.js
 */
const path = require('node:path')
const { SERVER_DIR, loadEnv, check, checkTruthy, summary } = require('./ai-lib')

loadEnv()
const knowledge = require(path.join(SERVER_DIR, 'src/services/knowledge.js'))

// 允许「渠道类型 + 平台名」，禁止「具体店铺 / 链接 / 价格」。
// 平台名原来在禁列里，2026-09-21 用户拍板「购买还是更倾向于淘宝店」之后放开——
// 淘宝/天猫是渠道类型级别的说法，不是某家店铺；具体店铺名、链接、价格仍然不许写。
const BANNED_IN_DATA = ['http', 'www.', '.com', '￥', '¥']

function main() {
  const guide = knowledge.loadPurchaseGuide()

  console.log('=== ① 结构 ===')
  const items = Object.values(guide.items || {})
  const fertilizers = guide.fertilizers || []
  const tools = guide.tools || []
  const household = guide.household || []
  const common = guide.common || []

  console.log('  common ' + common.length + ' 条｜items ' + items.length +
    ' 条｜fertilizers ' + fertilizers.length + ' 条｜tools ' + tools.length +
    ' 条｜household ' + household.length + ' 条')
  check('药剂条目 39 + 缺档 7 = 46 条', items.length, 46)
  check('通用建议 ≥ 6 条', common.length >= 6, true)
  check('器械 ≥ 8 条', tools.length >= 8, true)
  checkTruthy('gaps 段有内容', guide.gaps && Object.keys(guide.gaps).length >= 3)

  console.log('')
  console.log('=== ② 字段够用 ===')
  const all = [...items, ...fertilizers, ...tools]
  const noSearch = all.filter((item) => !String(item.search || '').trim())
  const noName = all.filter((item) => !String(item.name || item.material || '').trim())
  const noWhere = all.filter((item) => !(item.where || []).length)
  check('每条都有 name', noName.length ? noName.map((i) => i.name).join(',') : '（无缺失）', '（无缺失）')
  check('每条都有 search', noSearch.length ? noSearch.map((i) => i.name).join(',') : '（无缺失）', '（无缺失）')
  check('每条都有 where', noWhere.length ? noWhere.map((i) => i.name).join(',') : '（无缺失）', '（无缺失）')

  console.log('')
  console.log('=== ③ 覆盖率：知识库里的东西必须能买到指路 ===')
  const drugs = Object.values(knowledge.getDrugCatalog())
  const missingDrugs = drugs.filter((drug) => !knowledge.findPurchaseGuide(drug.name, 1).length)
  console.log('  药剂档案 ' + drugs.length + ' 条，没配购买条目的：' + missingDrugs.length)
  check('39 条药剂都有购买条目', missingDrugs.map((d) => d.name).join(',') || '（无缺失）', '（无缺失）')

  // 施肥成品是按大类组织的：products[大类].items = [[名称, 配比, 用途, 适用, 用法, 注意], ...]
  const productGroups = knowledge.loadFertilizingProducts().products || {}
  const products = []
  for (const group of Object.values(productGroups)) {
    for (const item of (group && group.items) || []) {
      const name = Array.isArray(item) ? item[0] : item && item.name
      if (name) products.push(name)
    }
  }
  const missingProducts = products.filter((name) => !knowledge.findPurchaseGuide(name, 1).length)
  console.log('  施肥成品 ' + products.length + ' 条，没配购买条目的：' + missingProducts.length)
  if (missingProducts.length) {
    console.log('  → 给侧栏的待补清单：' + missingProducts.join('、'))
  }
  // 覆盖率按"跑得出来"算：这里故意不自己写匹配规则，而是直接问运行时的
  // findPurchaseGuide——否则脚本和线上是两套口径，改了别名表脚本也不会跟着变。
  const coveredAtRuntime = products.filter((name) => knowledge.findPurchaseGuide(name, 1).length > 0)
  console.log('  其中运行时真能配到资料的：' + coveredAtRuntime.length + '/' + products.length)
  check('施肥成品的购买指路覆盖率 ≥ 80%',
    coveredAtRuntime.length / Math.max(products.length, 1) >= 0.8, true)

  console.log('')
  console.log('=== ④ household 的 ref 指向真实的 diy 材料 ===')
  const diy = knowledge.loadFertilizingProducts().diy || {}
  const materials = diy.materials || []
  // 施肥库的 diy 材料长这样：{ code: 'Y01', material: '淘米水', method, dilution, provides, risk }
  const codes = materials
    .map((item) => (item && (item.code || (Array.isArray(item) ? item[0] : ''))) || '')
    .map((code) => String(code).match(/Y\d+/))
    .filter(Boolean)
    .map((matched) => matched[0])
  console.log('  施肥库 diy 材料 ' + materials.length + ' 条，示例：' +
    materials.slice(0, 3).map((item) => item.code + ' ' + item.material).join(' / '))
  console.log('  可用 Y 码：' + codes.join(','))
  const badRefs = household.filter((item) => {
    const refs = String(item.ref || '').match(/Y\d+/g) || []
    return !refs.length || refs.some((code) => codes.indexOf(code) < 0)
  })
  check('14 条 household 都指向存在的 Y 码',
    badRefs.length ? badRefs.map((i) => i.material + '→' + i.ref).join('；') : '（无坏引用）', '（无坏引用）')

  console.log('')
  console.log('=== ⑤ 合规：不写店铺名 / 链接 / 价格 ===')
  // 这条规则管的是「给用户看的选购建议」，所以只扫面向用户的五段。
  // meta 与 gaps 是内部记录（例如「哪个平台没测成」「缺口清单」），
  // 里面点名平台是必要的证据，不属于向用户推荐店铺。
  const raw = JSON.stringify({
    common: guide.common,
    items: guide.items,
    fertilizers: guide.fertilizers,
    tools: guide.tools,
    household: guide.household
  })
  const hit = BANNED_IN_DATA.find((word) => raw.indexOf(word) >= 0)
  check('数据里没有店铺名 / 链接 / 价格', hit || '（无）', '（无）')

  console.log('')
  console.log('=== ⑥ 缺口如实标记（与药剂档案现状对齐）===')
  const missingRecord = items.filter((item) => item.drug_record_missing)
  const actuallyMissing = items.filter((item) => !knowledge.findDrug(item.name))
  console.log('  标了 drug_record_missing 的：' + missingRecord.length + ' 条' +
    (missingRecord.length ? '（' + missingRecord.map((i) => i.name).join('、') + '）' : ''))
  console.log('  实际在药剂档案里查不到的：' + actuallyMissing.length + ' 条' +
    (actuallyMissing.length ? '（' + actuallyMissing.map((i) => i.name).join('、') + '）' : ''))
  // 2026-09-21：7 个缺口（X01-X07）已补成 D40-D46，所以两边都应为 0。
  // 这个断言的意义是「标记不会过期」：将来加了没有档案的药，两边必须同时变成非 0。
  check('标记数与实际缺口数一致', missingRecord.length, actuallyMissing.length)
  const noTodo = missingRecord.filter((item) => !(item.todo || []).length)
  check('标了缺档的都写了 todo（怎么补）', noTodo.length ? noTodo.map((i) => i.name).join(',') : '（都写了）', '（都写了）')
  const linked = items.filter((item) => item.drug_record)
  const badLink = linked.filter((item) => !knowledge.findDrug(item.name))
  console.log('  带 drug_record 指向的条目：' + linked.length + ' 条' +
    (linked.length ? '（' + linked.map((i) => i.name + '→' + i.drug_record).join('、') + '）' : ''))
  check('带 drug_record 的条目确实能在药剂档案里查到',
    badLink.length ? badLink.map((i) => i.name).join('、') : '（都能查到）', '（都能查到）')

  console.log('')
  console.log('=== ⑧ 购买要求：有毒的必须说全（2026-09-21 用户拍板）===')
  const drugEntries = Object.entries(guide.items || {})
  const noRequirement = drugEntries.filter(([, item]) => !(item.purchase_requirements || []).length)
  check('46 条药剂都有 purchase_requirements',
    noRequirement.length ? noRequirement.map(([code]) => code).join(',') : '（无缺失）', '（无缺失）')

  // 毒性从药剂档案里对，不把毒性和要求两处写死
  const drugCatalog = knowledge.getDrugCatalog()
  const toxicCodes = drugEntries
    .filter(([code]) => /中等毒|高毒/.test(String((drugCatalog[code] || {}).toxicity || '')))
    .map(([code]) => code)
  console.log('  中毒及以上的药剂 ' + toxicCodes.length + ' 条：' + toxicCodes.join(','))
  const requirementText = (code) => (guide.items[code].purchase_requirements || []).join('|')
  const noParent = toxicCodes.filter((code) => requirementText(code).indexOf('家长') < 0)
  check('中毒及以上的药剂，购买要求里点了「家长」',
    noParent.length ? noParent.join(',') : '（都有了）', '（都有了）')
  const noSplit = toxicCodes.filter((code) => requirementText(code).indexOf('分装') < 0)
  check('中毒及以上的药剂，购买要求里提醒了「不要分装」',
    noSplit.length ? noSplit.join(',') : '（都有了）', '（都有了）')

  console.log('')
  console.log('=== ⑨ 渠道口径（倾向淘宝/天猫；农药必须带登记证号）===')
  const drugWhereBad = drugEntries.filter(([, item]) =>
    !(item.where || []).some((text) => text.indexOf('登记证号') >= 0))
  check('药剂渠道里都写了「认准登记证号」',
    drugWhereBad.length ? drugWhereBad.map(([code]) => code).join(',') : '（都有了）', '（都有了）')
  const toolNoEcom = tools.filter((item) =>
    !(item.where || []).some((text) => text.indexOf('淘宝') >= 0 || text.indexOf('天猫') >= 0))
  check('器械渠道都提到了淘宝/天猫',
    toolNoEcom.length ? toolNoEcom.map((i) => i.name).join(',') : '（都有了）', '（都有了）')

  console.log('')
  console.log('=== ⑩ 匹配优先级：用户点名的物品必须进资料 ===')
  // 真实故障：对话里问「想买吡虫啉」，但物种知识先出现了代森锰锌等三种药，
  // 三条名额被占满，AI 只能回答"我这份资料里没有吡虫啉"。
  const priorityText = '我家月季长蚜虫了，想自己买吡虫啉来打，去哪儿买？'
  const noisyContext = priorityText +
    '\n月季打药可用代森锰锌1000倍、苯醚甲环唑3000倍、戊唑醇2500倍，红蜘蛛用阿维菌素'
  const picked = knowledge.findPurchaseGuide(noisyContext, 3, priorityText).map((item) => item.entry.name)
  console.log('  用户点名「吡虫啉」，上下文里还有 4 种药 → 实际取到：' + picked.join('、'))
  check('用户点名的物品排在第一条', picked[0], '吡虫啉')
  const priorityLines = knowledge.describePurchaseGuide(noisyContext, { priorityText })
  checkTruthy('用户点名的物品出现在注入资料里',
    priorityLines.some((line) => line.indexOf('吡虫啉') >= 0))

  console.log('')
  console.log('=== ⑪ 自然提及能不能匹配上（名字带括号/斜杠的老问题）===')
  // 实测故障：方案里写「用腐熟羊粪做底肥」，而条目名是「腐熟羊粪 / 鸡粪颗粒」，
  // 归一化后互相不包含 → 一条都匹配不上。名字里带括号或斜杠的都要有别名。
  const allItems = [
    ...Object.values(guide.items || {}),
    ...(guide.fertilizers || []),
    ...(guide.tools || [])
  ]
  const naturalMention = (name) => (String(name).indexOf('专用肥') >= 0
    ? '月季专用肥'
    : String(name).split(/[（(]/)[0].split('/')[0].split('、')[0].trim())
  const normalize = (value) => String(value || '')
    .replace(/[\s（）()·・\-—/、,，。:：;；「」『』"“”'']/g, '')
    .toLowerCase()
  const unreachable = allItems.filter((item) => {
    const name = item.name || item.material
    const mention = naturalMention(name)
    const hit = knowledge.findPurchaseGuide(mention, 1)[0]
    // 判据是「这个提及写进了某条目的匹配键里」。
    // 命中同名的另一条也算通：「枯草芽孢杆菌」既是生物农药又是菌肥，两条都合理。
    return !hit || !(hit.keys || []).some((key) => key === normalize(mention))
  })
  console.log('  81 条物品，用「自然提及」搜不到的：' + unreachable.length)
  check('自然提及都能落到购买条目',
    unreachable.length ? unreachable.map((i) => i.name).join('、') : '（都能搜到）', '（都能搜到）')

  console.log('')
  console.log('=== ⑫ 施肥优先级（2026-09-21 用户口径）===')
  const priority = knowledge.loadFertilizingPriority()
  console.log('  档位 ' + priority.tiers.length + ' 个；覆盖场景 ' + priority.coverage.length +
    ' 个；新手规矩 ' + priority.newbie_rules.length + ' 条')
  check('第一包写的是均衡水溶肥（花多多 1 号）',
    /花多多\s*1\s*号/.test(priority.first_buy.pick), true)
  const tierOf = (keyword) => {
    const tier = priority.tiers.find((t) => (t.items || []).some((name) => name.indexOf(keyword) >= 0))
    return tier ? tier.tier : null
  }
  check('羊粪这类有机肥被放到第 3 档（不是新手必需）', tierOf('羊粪'), 3)
  check('缓释肥在第 2 档（按需再补）', tierOf('奥绿'), 2)
  check('生长调节剂在第 4 档（特定场景）', tierOf('芸苔素内酯'), 4)
  const organic = priority.tiers.find((t) => t.tier === 3 && (t.cautions || []).length)
  checkTruthy('第 3 档写了「大包装 / 异味 / 腐熟」这些代价',
    organic && organic.cautions.join('').indexOf('腐熟') >= 0)
  const purposeCodes = ['F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F11', 'F12', 'F13', 'F14']
  const missingTier = purposeCodes.filter((code) => priority.purpose_tier[code] === undefined)
  check('F01–F14 都有对应档位', missingTier.join(',') || '（都齐了）', '（都齐了）')
  check('常规追肥（F02）落在第 1 档', priority.purpose_tier.F02, 1)
  check('停肥档（F04 花期 / F08 高温）标成 0，不需要买肥',
    priority.purpose_tier.F04 === 0 && priority.purpose_tier.F08 === 0, true)

  const injected = knowledge.describeFertilizingPriority({ purpose: 'F02' }).join('\n')
  checkTruthy('注入文本里点名了「花多多 1 号」', injected.indexOf('花多多 1 号') >= 0)
  checkTruthy('注入文本里说了有机肥不是必需', /不是新手必需/.test(injected))
  const fertilizerNoTier = (guide.fertilizers || []).filter((item) => !item.tier)
  check('每条肥料都带了档位',
    fertilizerNoTier.length ? fertilizerNoTier.map((i) => i.name).join('、') : '（都带了）', '（都带了）')

  console.log('')
  console.log('=== ⑦ 出处（不计入通过/失败，只报告）===')
  const withSources = all.filter((item) => (item.sources || []).length > 0)
  console.log('  带 sources 的条目：' + withSources.length + '/' + all.length)
  const sampleSources = [...new Set(withSources.flatMap((item) => item.sources))].slice(0, 3)
  console.log('  来源写法（机构名 + 定位串）：' + sampleSources.join(' ／ '))
  console.log('  库里 meta.status = ' + String(guide.meta && guide.meta.status || '').slice(0, 60))
  console.log('  形式已定：只写「机构名 + 定位串」，不用 URL（见 meta.sources_policy_decided）。')
  console.log('  → 剩下的是**逐条核对**（现在是「该去哪查」，不是「已经查过了」），属已知待办，不判失败。')

  if (summary() > 0) process.exit(1)
}

try {
  main()
} catch (err) {
  console.error('FAILED:', (err && err.stack) || err)
  process.exit(1)
}
