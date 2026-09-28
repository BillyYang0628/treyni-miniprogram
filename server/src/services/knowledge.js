const fs = require('node:fs')
const path = require('node:path')
const config = require('../config')

// 知识库：前三个分别对应不同提醒和不同界面内容，purchaseGuide 是"怎么买"的翻译层
const LIBRARIES = {
  daily_care: { name: 'daily_care', label: '植物日常养护库', file: 'daily_care.json' },
  fertilizing: { name: 'fertilizing', label: '施肥库', file: 'fertilizing.json' },
  pesticide: { name: 'pesticide', label: '病虫害用药库', file: 'pesticide.json' },
  purchaseGuide: { name: 'purchaseGuide', label: '购买指南库', file: 'purchase_guide.json' }
}

const KNOWLEDGE_DIR = path.resolve(config.rootDir, 'data', 'knowledge')
const SUPPLEMENT_DIR = path.resolve(config.rootDir, 'knowledge')

// 提醒类型 → 知识库 + 库内字段
const CARE_TYPE_MAP = {
  watering: { library: 'daily_care', field: 'watering' },
  fertilizing: { library: 'fertilizing', field: '' },
  pesticide: { library: 'pesticide', field: '' },
  pruning: { library: 'daily_care', field: 'pruning' }
}

const cache = {}

// 旧版知识库用过的泛称，用户手动输入时也能命中一个代表品种
const LEGACY_ALIASES = {
  多肉: '玉露',
  仙人掌: '金琥',
  绿植: '绿萝',
  观叶: '绿萝',
  观叶植物: '绿萝',
  兰花: '蝴蝶兰',
  草花: '向日葵',
  盆景: '真柏',
  藤本: '常春藤',
  蕨类: '铁线蕨',
  水生: '铜钱草',
  香草: '薄荷',
  蔬菜: '生菜'
}

function readJson(name, fallback) {
  if (cache[name]) return cache[name]

  try {
    cache[name] = JSON.parse(fs.readFileSync(path.join(KNOWLEDGE_DIR, name), 'utf8'))
  } catch (e) {
    console.warn('[knowledge] 读取 ' + name + ' 失败：' + e.message)
    cache[name] = fallback
  }

  return cache[name]
}

const loadPlants = () => readJson('plants.json', {})
const loadCareGroups = () => readJson('care_groups.json', {})
const loadDailyCare = () => readJson('daily_care.json', {})
const loadFertilizing = () => readJson('fertilizing.json', {})
const loadFertilizingGroups = () => readJson('fertilizing_groups.json', { groups: {}, stages: [], details: {} })
const loadFertilizingPurposes = () => readJson('fertilizing_purposes.json', {})
const loadFertilizingProducts = () => readJson('fertilizing_products.json', { products: {}, diy: { materials: [], notes: [] } })
const loadFertilizingRules = () => readJson('fertilizing_rules.json', {})
const loadFertilizingPriority = () =>
  readJson('fertilizing_priority.json', { tiers: [], coverage: [], newbie_rules: [], purpose_tier: {} })
const loadPesticide = () => readJson('pesticide.json', {})
const loadPesticideDiseases = () => readJson('pesticide_diseases.json', {})
const loadPesticideDrugs = () => readJson('pesticide_drugs.json', { drugs: {}, safety: [] })
const loadLibraryMeta = () => readJson('meta.json', {})
const loadPurchaseGuide = () =>
  readJson('purchase_guide.json', { common: [], items: {}, fertilizers: [], tools: [], household: [] })

/** 品种索引：中文名 / 别名 / 学名 → 品种 ID */
let speciesIndex = null

function buildIndex() {
  if (speciesIndex) return speciesIndex

  speciesIndex = {}
  const plants = loadPlants()

  for (const [id, item] of Object.entries(plants)) {
    speciesIndex[id] = id
    if (item.cn_name) speciesIndex[item.cn_name] = id
    if (item.scientific_name) speciesIndex[item.scientific_name.toLowerCase()] = id
    for (const alias of item.aliases || []) {
      if (alias) speciesIndex[alias] = id
    }
    for (const scene of item.scene || []) {
      // 场景不是品种名，跳过
      void scene
    }
  }

  return speciesIndex
}

/**
 * 按品种名找到知识库条目。
 * 依次尝试：精确匹配中文名 → 别名 / 学名 → 包含匹配（例如“微型月季”→“月季”）。
 */
function findSpecies(species) {
  const raw = String(species || '').trim()
  if (!raw) return null

  const plants = loadPlants()
  const index = buildIndex()

  const exact = index[raw] || index[raw.toLowerCase()]
  if (exact) return { id: exact, entry: plants[exact] }

  if (LEGACY_ALIASES[raw] && plants[LEGACY_ALIASES[raw]]) {
    return { id: LEGACY_ALIASES[raw], entry: plants[LEGACY_ALIASES[raw]] }
  }

  // 包含匹配：用户填的品种里含有品种名，或品种名含有用户输入
  let best = null
  for (const [id, item] of Object.entries(plants)) {
    const names = [id, item.scientific_name, ...(item.aliases || [])].filter(Boolean)
    const hit = names.some((name) => {
      const text = String(name)
      if (text.length < 2) return false
      return raw.includes(text) || (raw.length >= 2 && text.includes(raw))
    })
    if (hit && (!best || id.length > best.id.length)) {
      best = { id, entry: item }
    }
  }

  return best
}

/**
 * 取某个品种某项养护的规则。
 * 返回 { speciesId, interval_days, note, detail, library, libraryLabel, careGroup }
 */
function getCareRule(species, type) {
  const mapping = CARE_TYPE_MAP[type]
  if (!mapping) return null

  const found = findSpecies(species)
  if (!found) return null

  const libraryName = mapping.library
  const library = LIBRARIES[libraryName]
  const source = libraryName === 'daily_care'
    ? loadDailyCare()
    : (libraryName === 'fertilizing' ? loadFertilizing() : loadPesticide())

  const entry = source[found.id]
  const payload = mapping.field ? (entry && entry[mapping.field]) : entry
  if (!payload) return null

  return {
    speciesId: found.id,
    species: found.entry,
    library: libraryName,
    libraryLabel: library.label,
    careGroup: found.entry.care_group,
    careGroupLabel: found.entry.care_group_label,
    interval_days: Number(payload.interval_days) || null,
    note: payload.note || '',
    detail: payload.detail || ''
  }
}

/**
 * 取品种的环境信息（光照 / 温度 / 休眠），用于 AI 生成方案时补充上下文。
 */
function getEnvironment(species) {
  const found = findSpecies(species)
  if (!found) return null

  const daily = loadDailyCare()[found.id]
  if (!daily) return null

  return {
    speciesId: found.id,
    light: daily.light || '',
    temperature: daily.temperature || '',
    dormancy: daily.dormancy || ''
  }
}

/** 栽培类型模板，用于品种不在库中时给出兜底节奏 */
function getCareGroup(careGroup) {
  const groups = loadCareGroups()
  return groups[careGroup] || null
}

/** 读取 knowledge 目录下的补充资料，按段落切分，供 AI 对话和诊断检索 */
function loadDocs() {
  if (cache.__docs) return cache.__docs

  const docs = []
  let files = []

  try {
    files = fs.readdirSync(SUPPLEMENT_DIR)
  } catch (e) {
    cache.__docs = docs
    return docs
  }

  for (const file of files) {
    const absolute = path.join(SUPPLEMENT_DIR, file)
    const ext = path.extname(file).toLowerCase()
    let text = ''

    try {
      const raw = fs.readFileSync(absolute, 'utf8')
      text = ext === '.json' ? JSON.stringify(JSON.parse(raw), null, 2) : raw
    } catch (e) {
      console.warn('[knowledge] 读取 ' + file + ' 失败：' + e.message)
      continue
    }

    const chunks = text
      .split(/\n\s*\n/)
      .map((item) => item.trim())
      .filter((item) => item.length > 10)

    if (chunks.length) {
      docs.push({ file, title: path.basename(file, ext), chunks })
    }
  }

  cache.__docs = docs
  return docs
}

/** 关键词检索补充资料，返回命中的段落 */
function searchDocs(keywords, limit = 5) {
  const terms = (Array.isArray(keywords) ? keywords : [keywords])
    .map((item) => String(item || '').trim())
    .filter(Boolean)

  if (!terms.length) return []

  const hits = []

  for (const doc of loadDocs()) {
    for (const chunk of doc.chunks) {
      const score = terms.reduce((sum, term) => (chunk.includes(term) ? sum + 1 : sum), 0)
      if (score > 0) hits.push({ file: doc.file, title: doc.title, chunk, score })
    }
  }

  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => ({ file: item.file, title: item.title, content: item.chunk }))
}

function listSpecies() {
  return Object.keys(loadPlants())
}

function getStats() {
  const meta = loadLibraryMeta()
  return {
    species: Object.keys(loadPlants()).length,
    careGroups: Object.keys(loadCareGroups()).length,
    dailyCare: Object.keys(loadDailyCare()).length,
    fertilizing: Object.keys(loadFertilizing()).length,
    pesticide: Object.keys(loadPesticide()).length,
    purchaseGuide: Object.keys(loadPurchaseGuide().items || {}).length,
    purchaseGuideFertilizers: (loadPurchaseGuide().fertilizers || []).length,
    purchaseGuideTools: (loadPurchaseGuide().tools || []).length,
    // 病虫害档案与药剂档案的条数：改完知识库重启后，看这两个数就能确认新数据真的加载了
    diseases: Object.keys(loadPesticideDiseases()).length,
    drugs: Object.keys(loadPesticideDrugs().drugs || {}).length,
    supplements: loadDocs().length,
    generatedAt: meta.generated_at || ''
  }
}

/** 病虫害索引：把「叶斑病 / 黑斑病」这类名称拆成关键词 */
let diseaseIndex = null

function buildDiseaseIndex() {
  if (diseaseIndex) return diseaseIndex

  diseaseIndex = {}
  for (const [code, item] of Object.entries(loadPesticideDiseases())) {
    diseaseIndex[code] = code
    const keywords = String(item.name || '')
      .split(/[/、（）()\s]+/)
      .map((word) => word.trim())
      .filter((word) => word.length >= 2)
    // 别名：品种速查表和常见叫法（例如「黑腐病」「球茎腐烂」「烟煤病」）
    // 指向同一条档案。以前只认 name，导致 38/101 个品种的病虫害名查不到档案，
    // 用药指导提示词里整段「病虫害用药库」会消失（见 verify-knowledge-coverage.js）。
    for (const alias of Array.isArray(item.aliases) ? item.aliases : []) {
      const clean = String(alias || '').trim()
      if (clean.length >= 2) keywords.push(clean)
    }
    for (const word of keywords) diseaseIndex[word] = code
  }

  return diseaseIndex
}

/** 按病害名找病虫害档案，例如「黑斑病」→ P01 */
function findDisease(name) {
  const raw = String(name || '').trim()
  if (!raw) return null

  const diseases = loadPesticideDiseases()
  const index = buildDiseaseIndex()

  if (index[raw]) return { code: index[raw], entry: diseases[index[raw]] }

  let best = null
  for (const [keyword, code] of Object.entries(index)) {
    if (keyword.length < 2) continue
    if (raw.includes(keyword) || keyword.includes(raw)) {
      if (!best || keyword.length > best.keyword.length) best = { keyword, code }
    }
  }

  return best ? { code: best.code, entry: diseases[best.code] } : null
}

/** 按药名找药剂档案，例如「苯醚甲环唑」→ D06 */
function findDrug(name) {
  const raw = String(name || '').trim()
  if (!raw) return null

  const { drugs } = loadPesticideDrugs()
  const list = Object.values(drugs).filter((item) => item && item.name)

  // 1) 精确匹配优先（含别名）。
  // 以前是「先到先得」，实测把「甲氨基阿维菌素苯甲酸盐（甲维盐）」解析成了 D21 阿维菌素
  // —— 因为 D21 排在前面，而全名里恰好包含「阿维菌素」四个字。
  for (const item of list) {
    if (item.name === raw) return item
    if (Array.isArray(item.aliases) && item.aliases.includes(raw)) return item
  }

  // 2) 双向包含，但按名字长度从长到短，避免短名截胡长名
  const byLength = list.slice().sort((a, b) => b.name.length - a.name.length)
  for (const item of byLength) {
    if (raw.includes(item.name)) return item
  }
  for (const item of byLength) {
    if (item.name.includes(raw)) return item
  }
  return null
}

/** 家庭用药安全红线 */
function getPesticideSafety() {
  return loadPesticideDrugs().safety || []
}

function getDrugCatalog() {
  return loadPesticideDrugs().drugs || {}
}

/**
 * 购买指南（2026-09-20 接入，库文件由侧栏维护：data/knowledge/purchase_guide.json）。
 *
 * 用途：把「苯醚甲环唑 3000 倍液」这种专业名翻译成用户能照做的一句话——搜什么词、
 * 去哪儿买、怎么判断正规。库只写渠道类型和判据，不写店铺名和链接。
 *
 * 三条接入口径：
 *   1. **不全量注入**：按"这条内容里真的出现了什么"匹配，最多 3 条（库有 90+ 条，全塞进去会淹掉正文）；
 *   2. 匹配不上的物品一律不给购买建议——编出来的品牌会被当成事实执行；
 *   3. household（家里现成的东西）不参与：那是"不用买"，不是"去哪儿买"。
 */
const PURCHASE_SECTION_LABEL = {
  pesticide: '药剂',
  fertilizer: '肥料',
  tool: '器械'
}

/**
 * 库里有些条目把同类物品合成了一个名字（「花宝 2 号 / 3 号」「观叶 / 月季 / 多肉 / 兰花等专用肥」）。
 * 按 "/" 拆 token 会让「月季」命中所有提到月季的文本，所以这里给一份**显式别名表**：
 * 只列真的会出现在方案里的写法。入库新条目时，如果名字里有斜杠或括号，记得在这里补一行。
 */
const PURCHASE_ALIASES = {
  '花宝 2 号 / 3 号': ['花宝2号', '花宝3号', '花宝'],
  '硝酸钙 / 氯化钙': ['硝酸钙', '氯化钙'],
  '观叶 / 月季 / 多肉 / 兰花等专用肥': ['专用肥', '月季专用肥', '观叶专用肥', '多肉专用肥', '兰花专用肥'],
  '枯草芽孢杆菌 / 哈茨木霉菌 / EM 菌': ['枯草芽孢杆菌', '哈茨木霉菌', 'EM菌', 'EM 菌'],
  '生根粉（ABT / 吲哚丁酸·萘乙酸）': ['生根粉', 'ABT', '吲哚丁酸', '萘乙酸'],
  '换盆工具（小铲、垫网）': ['换盆工具', '小铲', '垫网'],
  '好康多（Hi-Control）': ['好康多', 'Hi-Control'],
  '螯合铁（EDDHA-Fe）': ['螯合铁', 'EDDHA'],
  '通用水培营养液（A/B 液）': ['通用水培营养液', '水培营养液', 'A/B 液'],
  // 下面这些是 2026-09-21 扫出来的：名字里有括号或斜杠时，
  // 方案里只会写简称（「用腐熟羊粪做底肥」），不补别名就一条都匹配不上。
  '氢氧化铜 / 王铜': ['氢氧化铜', '王铜'],
  '甲氨基阿维菌素苯甲酸盐（甲维盐）': ['甲氨基阿维菌素苯甲酸盐', '甲维盐'],
  '苏云金杆菌（Bt）': ['苏云金杆菌', 'Bt'],
  '腐熟羊粪 / 鸡粪颗粒': ['腐熟羊粪', '羊粪', '鸡粪颗粒', '腐熟鸡粪'],
  '海藻酸 / 氨基酸水溶肥': ['海藻酸', '氨基酸水溶肥', '氨基酸肥'],
  '矾肥水（自制/成品）': ['矾肥水'],
  '小锯子 / 手锯': ['小锯子', '手锯', '盆景锯', '修枝锯'],
  '量勺 / 量杯': ['量勺', '量杯', '刻度勺'],
  'pH 试纸 / EC 笔': ['pH试纸', 'PH试纸', 'EC笔', 'pH 试纸'],
  '标签牌 / 记号笔': ['标签牌', '记号笔', '插牌']
}

/** 匹配前先去掉空格和标点：库里写「花多多 1 号」，方案里写「花多多1号」 */
function normalizeForMatch(value) {
  return String(value || '')
    .replace(/[\s（）()·・\-—/、,，。:：;；「」『』"“”'']/g, '')
    .toLowerCase()
}

let purchaseIndex = null

function buildPurchaseIndex() {
  if (purchaseIndex) return purchaseIndex

  const guide = loadPurchaseGuide()
  const entries = []

  const add = (entry, section) => {
    if (!entry || typeof entry !== 'object') return
    const name = String(entry.name || entry.material || '').trim()
    if (!name) return
    const keys = [name, ...(PURCHASE_ALIASES[name] || [])]
      .map(normalizeForMatch)
      .filter((key) => key.length >= 2)
    if (!keys.length) return
    entries.push({ section, entry, keys })
  }

  for (const item of Object.values(guide.items || {})) add(item, 'pesticide')
  for (const item of guide.fertilizers || []) add(item, 'fertilizer')
  for (const item of guide.tools || []) add(item, 'tool')

  purchaseIndex = { entries, common: Array.isArray(guide.common) ? guide.common : [] }
  return purchaseIndex
}

/**
 * 这段文字里提到了哪些"能买到的东西"（最多 limit 条）。
 *
 * priorityText 里的物品**先占名额**：实测踩过一次——用户问「想买吡虫啉」，
 * 但物种知识块里先出现了代森锰锌/苯醚甲环唑/戊唑醇，三条名额被它们占满，
 * 吡虫啉反而没进资料，AI 只能回答"我这份资料里没有吡虫啉"。
 * 用户明确问到的物品必须排在最前面。
 */
function findPurchaseGuide(text, limit = 3, priorityText = '') {
  const { entries } = buildPurchaseIndex()
  const hits = []

  const take = (haystack) => {
    if (!haystack) return
    // 命中可能有多条（「甲氨基阿维菌素苯甲酸盐」同时包含「阿维菌素」），
    // 按匹配到的键**长度从长到短**取：越长的名字越具体，越可能是用户说的那个。
    const candidates = []
    for (const item of entries) {
      if (hits.indexOf(item) >= 0) continue
      const matchedKey = item.keys
        .filter((key) => haystack.indexOf(key) >= 0)
        .sort((a, b) => b.length - a.length)[0]
      if (matchedKey) candidates.push({ item, length: matchedKey.length })
    }
    candidates.sort((a, b) => b.length - a.length)
    for (const candidate of candidates) {
      if (hits.length >= limit) return
      if (hits.indexOf(candidate.item) >= 0) continue
      hits.push(candidate.item)
    }
  }

  take(normalizeForMatch(priorityText))
  take(normalizeForMatch(text))
  return hits
}

/**
 * 拼成可直接塞进提示词的几行；没有命中就返回空数组（**调用方不要因此写购买建议**）。
 * @returns {string[]}
 */
function describePurchaseGuide(text, options = {}) {
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 3
  const hits = findPurchaseGuide(text, limit, options.priorityText || '')
  if (!hits.length) return []

  const lines = ['购买指路资料（只有这里列出的物品才可以给购买建议）：']
  // 中毒风险高的物品，光给要点模型会为了字数省掉（对话页实测省过两次），
  // 所以直接给一句可照抄的话 —— 「配药找家长」那句就是这么保证下来的。
  const mustWrite = []

  for (const item of hits) {
    const entry = item.entry
    const parts = []
    if (entry.search) parts.push('搜索词「' + entry.search + '」')
    if (Array.isArray(entry.where) && entry.where.length) parts.push('渠道：' + entry.where.join('、'))
    // 肥料带档位（第 1 档＝先买这一包，第 3 档＝对症/改土才买）
    if (entry.tier) parts.push('优先级：' + (entry.tier_label || ('第 ' + entry.tier + ' 档')))
    if (Array.isArray(entry.tips) && entry.tips.length) parts.push('选购：' + entry.tips.join('；'))
    if (Array.isArray(entry.avoid) && entry.avoid.length) parts.push('避免：' + entry.avoid.join('；'))
    // 购买要求按毒性生成：中毒的走下面那句「照这句写」，低毒的取前两条
    if (Array.isArray(entry.purchase_requirements) && entry.purchase_requirements.length) {
      const requirements = entry.purchase_requirements
      const isToxic = requirements.some((text) => text.indexOf('中等毒') >= 0)
      if (isToxic) {
        mustWrite.push('必须写进正文的购买要求（照这句写）：' + (entry.name || entry.material) +
          '的毒性标识是「中等毒」，请家长下单并帮忙保管，认准包装上 PD 开头的农药登记证号，' +
          '买最小包装，不要分装到饮料瓶里。')
      } else {
        parts.push('购买要求：' + requirements.slice(0, 2).join('；'))
      }
    }
    lines.push('- ' + (entry.name || entry.material) +
      '（' + (PURCHASE_SECTION_LABEL[item.section] || '物品') + '）：' + parts.join('｜'))
  }

  lines.push(...mustWrite)

  // 通用建议按命中的是什么东西挑（每条一般 40-90 字，一共最多 3 条）：
  //   农药：在哪儿买 + 怎么判断正规（登记证号）+ 怎么判断店铺靠谱（看销量更要看差评关键词）
  //   肥料：在哪儿买 + 怎么判断肥料正规（N-P-K 标注）+ 一次买多少
  //   只有器械：不谈农资合规——那把剪刀没有登记证号
  const sections = hits.map((item) => item.section)
  const wanted = sections.indexOf('pesticide') >= 0
    ? ['C01', 'C02', 'C06']
    : (sections.indexOf('fertilizer') >= 0 ? ['C01', 'C03', 'C04'] : ['C01', 'C08'])
  const common = buildPurchaseIndex().common
    .filter((item) => item && wanted.indexOf(item.id) >= 0)
    .slice(0, 3)
  for (const item of common) {
    lines.push('通用：' + item.topic + '——' + item.advice)
  }

  return lines
}

/** 某个品种在用药库里的常见病虫害明细 */
function getSpeciesPesticideTargets(species) {
  const found = findSpecies(species)
  if (!found) return null

  const entry = loadPesticide()[found.id]
  if (!entry) return null

  return {
    speciesId: found.id,
    commonPests: entry.common_pests || [],
    targets: entry.targets || [],
    advice: entry.advice || ''
  }
}

/** 某个品种的施肥大类信息（A1–A13） */
function getFertilizingPlan(species) {
  const found = findSpecies(species)
  if (!found) return null

  const entry = loadFertilizing()[found.id]
  if (!entry) return null

  const groups = loadFertilizingGroups()
  const group = (groups.groups || {})[entry.fert_group] || {}
  const detail = (groups.details || {})[entry.fert_group] || {}

  return {
    speciesId: found.id,
    groupCode: entry.fert_group,
    groupName: entry.group_label || group.name || '',
    intensity: entry.intensity || group.intensity || 'medium',
    intensityText: group.intensity_text || '',
    principle: group.principle || '',
    misconception: group.misconception || '',
    rhythm: entry.rhythm || detail.rhythm || '',
    products: entry.products || detail.products || '',
    diy: entry.diy || detail.diy || '',
    speciesNote: entry.species_note || '',
    groupNotes: detail.notes || ''
  }
}

/** 按关键词找施肥用途方案，例如「僵苗」→ F06、「换盆」→ F01 */
function findFertilizingPurpose(keyword) {
  const raw = String(keyword || '').trim()
  if (!raw) return null

  const purposes = loadFertilizingPurposes()
  if (purposes[raw]) return purposes[raw]

  let best = null
  for (const [code, item] of Object.entries(purposes)) {
    const words = String(item.name || '')
      .split(/[/、（）()\s]+/)
      .filter((word) => word.length >= 2)
    const hit = words.find((word) => raw.includes(word) || word.includes(raw))
    if (hit && (!best || hit.length > best.hit.length)) best = { hit, code, item }
  }

  return best ? best.item : null
}

/** 施肥的环境要求、混配禁忌与禁施清单 */
function getFertilizingRules() {
  return loadFertilizingRules()
}

/** 把禁施清单等关键约束整理成给 AI 的文本 */
function describeFertilizingRules() {
  const rules = loadFertilizingRules()
  const lines = []

  for (const [chapter, sections] of Object.entries(rules)) {
    for (const section of sections) {
      if (!section.items.length) continue
      // 只保留最关键的约束，避免提示词过长
      if (!/禁施|浓度|混配|禁忌|时机|检查/.test(section.title)) continue
      lines.push(section.title + '：' + section.items.join(' ').slice(0, 500))
    }
  }

  return lines
}

/** 把某个阶段的两个方案整理成给 AI 用的文本 */
/**
 * 施肥优先级：买哪几包、哪包覆盖哪些用途。
 *
 * 为什么单独有一层：原来只有大类顺序和每个用途的 A/B 备选，
 * 有机肥（大包装、有异味、要腐熟）和小包装水溶肥被平级对待，
 * 新手照着买容易先买回一大包羊粪。
 *
 * @param {object} options.purpose 命中的用途编号（F02 这种），用来挑「这一档该买什么」
 */
function describeFertilizingPriority(options = {}) {
  const data = loadFertilizingPriority()
  const lines = []
  // 默认输出紧凑版（给提示词用）；compact:false 才展开全部档位，给人工查表用
  const compact = options.compact !== false

  const first = data.first_buy
  if (first && first.pick) {
    lines.push('施肥优先级（先看这个再挑东西）：')
    lines.push('· 新手第一包：' + first.pick + '｜' + first.package + '｜覆盖 ' + first.covers)
  }

  const tierNote = options.purpose
    ? (data.purpose_tier || {})[String(options.purpose).toUpperCase()]
    : null
  if (tierNote !== null && tierNote !== undefined) {
    const label = {
      0: '这一档是「停肥 / 清水」，不需要买任何肥',
      1: '这一档用第一包（均衡水溶肥）就能覆盖',
      2: '这一档要按需补第二包（高磷钾 或 缓释肥）',
      3: '这一档是对症 / 改土才买',
      4: '这一档属于特定场景，不推荐新手自己配'
    }[tierNote]
    if (label) lines.push('· 这次这个场景（' + String(options.purpose).toUpperCase() + '）属于第 ' +
      tierNote + ' 档：' + label)
  }

  const tiers = data.tiers || []
  for (const tier of tiers) {
    if (compact && tier.tier > 2) continue
    const parts = ['第 ' + tier.tier + ' 档 ' + tier.label + '：' + (tier.items || []).join('、')]
    if (tier.covers && tier.covers.length) parts.push('覆盖：' + tier.covers.join('、'))
    if (tier.overlap) parts.push('和水溶肥的关系：' + tier.overlap)
    if (tier.cautions && tier.cautions.length) parts.push('代价：' + tier.cautions.join('；'))
    if (tier.note) parts.push(tier.note)
    lines.push('· ' + parts.join('｜'))
  }

  // 3-4 档压成两句：新手最需要知道的是"这两个不用急着买"，不是它们的全部细节
  if (compact) {
    const late = tiers.filter((tier) => tier.tier >= 3)
    const optional = late.filter((tier) => tier.tier === 3).map((tier) => (tier.items || []).join('、'))
    const specific = late.filter((tier) => tier.tier === 4).map((tier) => (tier.items || []).join('、'))
    if (optional.length) {
      lines.push('· 第 3 档（对症 / 改土才买，不是新手必需）：' + optional.join('、') +
        '——养分效果和水溶肥重叠；有机肥还有「大包装、可能有异味、必须腐熟」这几个代价，买就买 5-10 斤颗粒小包装。')
    }
    if (specific.length) {
      lines.push('· 第 4 档（' + specific.join('、') + '）：生长调节剂，特定场景才用，不推荐新手自己配。')
    }
  }

  if (data.newbie_rules && data.newbie_rules.length) {
    lines.push('新手买肥的规矩：' + (compact ? data.newbie_rules.slice(0, 3) : data.newbie_rules).join('；'))
  }

  return lines
}

/** 某个用途（F01–F14）落在第几档 */
function fertilizingTierFor(purposeCode) {
  const map = loadFertilizingPriority().purpose_tier || {}
  const value = map[String(purposeCode || '').toUpperCase()]
  return value === undefined ? null : value
}

/** 把某个阶段的两个方案整理成给 AI 用的文本 */
function describeScheme(disease, stage) {
  const stages = disease && disease.entry && disease.entry.stages
  const plan = stages && stages[stage]
  if (!plan) return ''

  const condition = plan.a_condition || plan.b_condition || ''
  const label = condition ? `（${condition}）` : ''
  return [
    label + '方案 A：' + (plan.a || '—'),
    '方案 B：' + (plan.b || '—')
  ].join('；')
}

/**
 * 第一个疗程无效时该换的药（方案 B）。
 * 优先用该品种速查表里的「换用方案」，没有再用病虫害档案里「轻度 → 中重度 → 预防期」的方案 B。
 * 会跳过酒精擦拭这类只适合早期的非药剂做法。
 */
function getAlternativeScheme(diseaseName, speciesName) {
  const isChemical = (text) => /倍|稀释|波美度/.test(String(text || ''))
  const pickChemical = (text) => {
    const parts = String(text || '').split('/').map((item) => item.trim()).filter(Boolean)
    return parts.find(isChemical) || parts[0] || ''
  }

  // 1) 品种速查表里的换用方案
  const speciesEntry = speciesName ? getSpeciesPesticideTargets(speciesName) : null
  if (speciesEntry && speciesEntry.targets.length) {
    const keywords = String(diseaseName || '').split(/[/、（）()\s]+/).filter((word) => word.length >= 2)
    const row = speciesEntry.targets.find((item) =>
      keywords.some((word) => item.name.includes(word)) || item.name.includes(diseaseName)
    )
    if (row && row.alternative && row.alternative !== '—') {
      return {
        disease: row.name,
        source: speciesEntry.speciesId + ' 的换用方案',
        text: pickChemical(row.alternative)
      }
    }
  }

  // 2) 病虫害档案里的方案 B
  const found = findDisease(diseaseName)
  if (!found) return null

  const stages = found.entry.stages || {}
  for (const stage of ['mild', 'severe', 'prevention']) {
    const plan = stages[stage]
    if (plan && plan.b && isChemical(plan.b)) {
      return {
        disease: found.entry.name,
        code: found.code,
        stage,
        source: found.code,
        text: pickChemical(plan.b)
      }
    }
  }

  return null
}

module.exports = {
  LIBRARIES,
  CARE_TYPE_MAP,
  loadPlants,
  loadCareGroups,
  loadDailyCare,
  loadFertilizing,
  loadFertilizingGroups,
  loadFertilizingPurposes,
  loadFertilizingProducts,
  loadFertilizingRules,
  loadFertilizingPriority,
  loadPesticide,
  loadPesticideDiseases,
  loadPesticideDrugs,
  loadPurchaseGuide,
  findSpecies,
  getCareRule,
  getEnvironment,
  getCareGroup,
  findDisease,
  findDrug,
  getPesticideSafety,
  getDrugCatalog,
  findPurchaseGuide,
  describePurchaseGuide,
  getSpeciesPesticideTargets,
  getFertilizingPlan,
  findFertilizingPurpose,
  getFertilizingRules,
  describeFertilizingRules,
  describeFertilizingPriority,
  fertilizingTierFor,
  describeScheme,
  getAlternativeScheme,
  loadDocs,
  searchDocs,
  listSpecies,
  getStats
}
