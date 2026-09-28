/**
 * 土壤水分基准（用户确认过的「现在土里还有多少水」）。
 *
 * 背景（2026-09-18 用户清单）：
 *   waterModel.projectWatering 每次推演都从「tank = 100 = 刚浇透」开始，
 *   也就是默认这盆植物今天就浇透过。于是「剩余约 X%」永远只反映今天一天的消耗，
 *   跟用户实际哪天浇的水毫无关系——用户填「现在土壤是刚浇过水的状态」也不会有任何变化。
 *
 * 现在：把用户确认过的土壤状态存成基准（存在 reminder 的 meta_json 里，不改表结构），
 *   水分账户 = 基准值 − 距基准日的天数 × 每日消耗；
 *   下次浇水日期 = 今天 + 剩余水量还能撑几天。
 *
 * 基准可以从三个地方产生：
 *   1. 用户第一次点进浇水提醒详情时自己选（前端四档按钮）；
 *   2. 「重新生成这份方案」里填的文字；
 *   3. AI 花农对话里说的话。
 *   后两个走下面的 detectLevel() 做识别，识别到就自动更新基准。
 */

// 四档土壤湿度，percent 是水分账户值（100 = 刚浇透）
const LEVELS = {
  soaked: { percent: 100, label: '刚浇过水' },
  wet: { percent: 70, label: '还有点湿' },
  half: { percent: 40, label: '半干' },
  dry: { percent: 10, label: '已经干透' },
  rained: { percent: 100, label: '刚下过雨' }
}

// 识别用的关键词。放在这里而不是让 AI 判断，是因为这几个说法很固定，
// 用规则识别又快又稳，也不花钱。
const PATTERNS = [
  { level: 'soaked', test: /刚浇(过|了|上)?水|才浇(过|了)?水|浇透了|浇过水|刚浇透|今天浇(过|了)水/ },
  { level: 'rained', test: /刚下(过)?雨|下了(一场)?雨|刚淋(过)?雨|被雨淋/ },
  { level: 'dry', test: /干透了|干得|已经很干|土很干|干裂|完全不湿|一点水都没有/ },
  { level: 'half', test: /半干|表面(有点)?干|有点干|快干了|该浇了/ },
  { level: 'wet', test: /还(有点|挺)?湿|土还是湿|比较湿|没干透/ }
]

function isLevel(value) {
  return Object.prototype.hasOwnProperty.call(LEVELS, value)
}

function percentOf(level) {
  return isLevel(level) ? LEVELS[level].percent : null
}

function labelOf(level) {
  return isLevel(level) ? LEVELS[level].label : ''
}

/**
 * 从一段中文里认出用户描述的土壤状态。
 * @returns {{level:string,label:string,percent:number}|null} 认不出来返回 null
 */
function detectLevel(text) {
  const value = String(text || '')
  if (!value.trim()) return null

  for (const item of PATTERNS) {
    if (item.test.test(value)) {
      return { level: item.level, label: LEVELS[item.level].label, percent: LEVELS[item.level].percent }
    }
  }
  return null
}

/** 从 reminder 的 meta_json 里读出基准；没有返回 null */
function readBaseline(metaJson) {
  let meta = {}
  try {
    meta = metaJson ? JSON.parse(metaJson) : {}
  } catch (e) {
    return null
  }
  const baseline = meta.water_baseline
  if (!baseline || typeof baseline.percent !== 'number' || !baseline.date) return null
  return baseline
}

function buildBaseline(level, date, source) {
  return {
    level,
    label: labelOf(level),
    percent: percentOf(level),
    date,
    source: source || 'user',
    confirmed_at: new Date().toISOString()
  }
}

/**
 * 按基准推算「现在还剩多少水」和「还能撑几天」。
 * @returns {{currentPercent:number, daysLeft:number, daysSince:number, dailyUse:number}|null}
 */
function projectFromBaseline(baseline, intervalDays, today) {
  if (!baseline) return null

  const interval = Number(intervalDays)
  if (!Number.isFinite(interval) || interval <= 0) return null

  const dailyUse = 100 / interval
  const start = new Date(baseline.date + 'T00:00:00+08:00')
  const end = new Date(today + 'T00:00:00+08:00')
  const daysSince = Math.max(0, Math.round((end - start) / 86400000))

  const currentPercent = Math.max(0, Math.min(100, Math.round(baseline.percent - daysSince * dailyUse)))
  const daysLeft = Math.max(1, Math.ceil(currentPercent / dailyUse))

  return {
    currentPercent,
    daysLeft,
    daysSince,
    dailyUse: Math.round(dailyUse * 10) / 10
  }
}

module.exports = {
  LEVELS,
  isLevel,
  labelOf,
  detectLevel,
  readBaseline,
  buildBaseline,
  projectFromBaseline
}
