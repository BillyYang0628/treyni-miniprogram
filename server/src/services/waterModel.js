/**
 * 天气系数模型（实现自《天气系数模型（计算与实现）》）
 *
 * 核心公式：
 *   W = ET₀ / 3.0
 *   I = I₀ × (3.0 / ET₀)^β × d × s        （知识库已有品种走这条路径，不再乘 E）
 *   β：户外 1.198 / 室内 0.766
 *   d：户外冬季 1.25，其余 1.0
 *   s：基质修正 = w / 0.30
 *
 * 浇水日期用逐日水量平衡推演：账户 100 = 刚浇透，
 * 每天按当天的 I 扣除 100/I，降雨按「有效雨量 / 盆内可用水」补回，
 * 补齐 100 就相当于浇了一次水（自然重置）。
 */
const fs = require('node:fs')
const path = require('node:path')
const config = require('../config')

const OPTIONS_FILE = path.resolve(config.rootDir, 'data', 'planting_options.json')

const ET0_REF = 3.0
const INTERVAL_MIN = 0.5
const INTERVAL_MAX = 45
const INDOOR_ET0_FLOOR = 1.2
const BETA_OUTDOOR = 1.198
const BETA_INDOOR = 0.766
const WINTER_FACTOR = 1.25

/**
 * 天气模型与知识库的修正系数。
 * 浇水节奏以天气模型为准；只有当两者差得太多（相差超过 60%）时，
 * 才按 0.7 × 天气模型 + 0.3 × 知识库 折中，结果仍然偏向天气模型。
 */
const CORRECTION_TRIGGER_RATIO = 1.6
const CORRECTION_MODEL_WEIGHT = 0.7

const SEASONAL_W = { spring: 1.19, summer: 1.49, autumn: 1.03, winter: 0.64 }

let optionsCache = null

function loadOptions() {
  if (optionsCache) return optionsCache
  try {
    optionsCache = JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8'))
  } catch (e) {
    console.warn('[waterModel] 读取种植条件参数失败：' + e.message)
    optionsCache = { soil_types: [], pot_specs: [], exposures: [], i0_overrides: {}, care_group_i0: {} }
  }
  return optionsCache
}

function normalize(text) {
  // 去掉空格再比较，“3加仑”与“3 加仑”视为同一个
  return String(text || '').replace(/\s+/g, '').toLowerCase()
}

function findOption(list, input) {
  const key = normalize(input)
  if (!key) return null

  const byId = list.find((item) => normalize(item.id) === key)
  if (byId) return byId

  const byName = list.find((item) => normalize(item.name) === key)
  if (byName) return byName

  // 关键词匹配：名称、别名互相包含
  let best = null
  for (const item of list) {
    const fields = [item.name, ...(item.aliases || [])].map(normalize)
    const hit = fields.some((field) => field && (field.includes(key) || key.includes(field)))
    if (hit && (!best || item.name.length > best.name.length)) best = item
  }
  return best
}

const getSoils = () => loadOptions().soil_types || []
const getPotSpecs = () => loadOptions().pot_specs || []
const getExposures = () => loadOptions().exposures || []

const findSoil = (input) => findOption(getSoils(), input)
const findPotSpec = (input) => findOption(getPotSpecs(), input)
const findExposure = (input) => findOption(getExposures(), input)

/** 基准间隔 I₀：优先用模型标定值，其次知识库间隔，最后按栽培类型兜底 */
function getBaseInterval({ species, intervalDays, careGroup }) {
  const options = loadOptions()
  const calibrated = options.i0_overrides || {}

  if (species && calibrated[species]) {
    return { i0: calibrated[species], source: 'calibrated' }
  }

  if (Number.isFinite(Number(intervalDays)) && Number(intervalDays) > 0) {
    return { i0: Number(intervalDays), source: 'knowledge' }
  }

  const groupValue = careGroup ? (options.care_group_i0 || {})[careGroup] : null
  if (groupValue) return { i0: groupValue, source: 'care_group' }

  return { i0: 3.0, source: 'default' }
}

function seasonOf(month) {
  if ([12, 1, 2].includes(month)) return 'winter'
  if ([3, 4, 5].includes(month)) return 'spring'
  if ([6, 7, 8].includes(month)) return 'summer'
  return 'autumn'
}

/** 大气顶层辐射 Ra（MJ/m²/天），Hargreaves 用 */
function extraterrestrialRadiation(latDeg, dayOfYear) {
  const lat = (latDeg * Math.PI) / 180
  const dr = 1 + 0.033 * Math.cos((2 * Math.PI * dayOfYear) / 365)
  const decl = 0.409 * Math.sin((2 * Math.PI * dayOfYear) / 365 - 1.39)
  const wsArg = Math.max(-1, Math.min(1, -Math.tan(lat) * Math.tan(decl)))
  const ws = Math.acos(wsArg)
  return ((24 * 60) / Math.PI) * 0.082 * dr * (ws * Math.sin(lat) * Math.sin(decl) +
    Math.cos(lat) * Math.cos(decl) * Math.sin(ws))
}

/**
 * ET₀ 三级降级：接口值 → 多元回归 → Hargreaves → 只用最高温。
 * 返回 { et0, source }；完全拿不到时返回 null。
 */
function estimateEt0({ et0, tmax, tmin, humidity, latitude, date }) {
  const value = Number(et0)
  if (Number.isFinite(value) && value > 0.05 && value < 15) {
    return { et0: value, source: 'api' }
  }

  const tMax = Number(tmax)
  const tMin = Number(tmin)
  const rh = Number(humidity)

  if (Number.isFinite(tMax) && Number.isFinite(tMin) && Number.isFinite(rh)) {
    const estimated = 2.275 + 0.1234 * tMax + 0.0762 * (tMax - tMin) - 0.03375 * rh
    if (estimated > 0.05 && estimated < 15) return { et0: estimated, source: 'regression' }
  }

  if (Number.isFinite(tMax) && Number.isFinite(tMin) && Number.isFinite(Number(latitude)) && date) {
    const d = new Date(date)
    const start = new Date(d.getFullYear(), 0, 0)
    const dayOfYear = Math.round((d - start) / 86400000)
    const ra = extraterrestrialRadiation(Number(latitude), dayOfYear)
    const tMean = (tMax + tMin) / 2
    const estimated = 0.0023 * (tMean + 17.8) * Math.sqrt(Math.max(0, tMax - tMin)) * ra * 0.408
    if (estimated > 0.05 && estimated < 15) return { et0: estimated, source: 'hargreaves' }
  }

  if (Number.isFinite(tMax)) {
    const estimated = 0.831 + 0.1196 * tMax
    if (estimated > 0.05 && estimated < 15) return { et0: estimated, source: 'tmax_only' }
  }

  return null
}

function seasonalEt0(month) {
  return SEASONAL_W[seasonOf(month)] * ET0_REF
}

/** 天气系数 W：室内套用 ET₀ 下限 1.2，避免北方冬季外推过久 */
function weatherCoefficient({ et0, indoor }) {
  const raw = Number(et0)
  const floorApplied = Boolean(indoor) && raw < INDOOR_ET0_FLOOR
  const used = floorApplied ? INDOOR_ET0_FLOOR : raw
  return {
    et0Used: used,
    floorApplied,
    w: used / ET0_REF
  }
}

/** 单日浇水间隔 I */
function computeInterval({ i0, et0, indoor, month, substrateW, weatherSource }) {
  const base = Number(i0) || 3
  const beta = indoor ? BETA_INDOOR : BETA_OUTDOOR
  const winter = !indoor && seasonOf(month) === 'winter'
  const d = winter ? WINTER_FACTOR : 1
  const s = Number.isFinite(Number(substrateW)) && Number(substrateW) > 0
    ? Number(substrateW) / 0.30
    : 1

  const coefficient = weatherCoefficient({ et0, indoor })
  const raw = base * Math.pow(ET0_REF / coefficient.et0Used, beta) * d * s
  const clamped = Math.max(INTERVAL_MIN, Math.min(INTERVAL_MAX, raw))

  return {
    intervalDays: Math.round(clamped * 100) / 100,
    rawInterval: Math.round(raw * 100) / 100,
    w: Math.round(coefficient.w * 1000) / 1000,
    et0Used: Math.round(coefficient.et0Used * 100) / 100,
    beta,
    winter,
    substrateFactor: Math.round(s * 1000) / 1000,
    floorApplied: coefficient.floorApplied,
    clamped: clamped !== raw,
    weatherSource: weatherSource || 'unknown'
  }
}

function round2(value) {
  return Math.round(value * 100) / 100
}

/**
 * 天气模型 ± 知识库的修正。
 * - 两者接近（比值在 1/1.6 ~ 1.6 之间）：完全采用天气模型；
 * - 差异过大：按 0.7×天气模型 + 0.3×知识库 折中，并记录两侧数值，便于界面如实展示。
 */
function applyCorrection({ intervalDays, baseIntervalDays }) {
  const model = Number(intervalDays)
  const base = Number(baseIntervalDays)

  if (!Number.isFinite(model) || model <= 0) {
    return { intervalDays: model, corrected: false, modelIntervalDays: null, baseIntervalDays: null }
  }

  if (!Number.isFinite(base) || base <= 0) {
    return { intervalDays: model, corrected: false, modelIntervalDays: model, baseIntervalDays: null }
  }

  const ratio = model / base
  const inRange = ratio <= CORRECTION_TRIGGER_RATIO && ratio >= 1 / CORRECTION_TRIGGER_RATIO

  if (inRange) {
    return {
      intervalDays: model,
      corrected: false,
      modelIntervalDays: model,
      baseIntervalDays: base,
      ratio: round2(ratio),
      modelWeight: 1
    }
  }

  const blended = model * CORRECTION_MODEL_WEIGHT + base * (1 - CORRECTION_MODEL_WEIGHT)
  const clamped = Math.max(INTERVAL_MIN, Math.min(INTERVAL_MAX, blended))

  return {
    intervalDays: round2(clamped),
    corrected: true,
    modelIntervalDays: model,
    baseIntervalDays: base,
    ratio: round2(ratio),
    modelWeight: CORRECTION_MODEL_WEIGHT
  }
}

/** 盆内可用水 AWC = 盆深(mm) × 基质可利用水占比 w */
function availableWater(potDepthMm, substrateW) {
  const depth = Number(potDepthMm)
  const w = Number(substrateW)
  if (!Number.isFinite(depth) || depth <= 0) return null
  if (!Number.isFinite(w) || w <= 0) return null
  return depth * w
}

function formatDate(date) {
  const d = date instanceof Date ? date : new Date(date)
  const pad = (value) => (value < 10 ? '0' + value : '' + value)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 逐日水量平衡推演。
 * daily 按时间升序，元素形如
 *   { date: '2026-09-14', et0, tmax, tmin, humidity, rainMm }
 * 返回下次浇水日期、账户剩余水量与推演过程。
 */
function projectWatering(options) {
  const {
    daily = [],
    i0,
    indoor = false,
    substrateW = 0.30,
    awcMm,
    rainFactor = 0,
    latitude = null,
    baseIntervalDays = null,
    today = formatDate(new Date())
  } = options

  if (!daily.length) {
    return { ok: false, error: '没有可用的天气数据' }
  }

  let tank = 100
  let currentTank = 100
  const steps = []
  let dueDate = null
  let overdue = false
  const rainDays = []

  for (const day of daily) {
    const date = day.date
    const month = new Date(date).getMonth() + 1
    const estimate = estimateEt0({
      et0: day.et0,
      tmax: day.tmax,
      tmin: day.tmin,
      humidity: day.humidity,
      latitude,
      date
    })

    const et0 = estimate ? estimate.et0 : seasonalEt0(month)
    const source = estimate ? estimate.source : 'seasonal'

    const interval = computeInterval({
      i0,
      et0,
      indoor,
      month,
      substrateW,
      weatherSource: source
    })

    // 天气模型为准，与知识库差得太多时按修正系数折中（仍偏向天气模型）
    const correction = applyCorrection({
      intervalDays: interval.intervalDays,
      baseIntervalDays
    })
    const effectiveInterval = correction.intervalDays

    const consume = 100 / effectiveInterval
    tank -= consume

    const rainMm = Number(day.rainMm) || 0
    const rainEffective = rainMm * (Number(rainFactor) || 0)
    let rainGain = 0

    if (rainEffective > 0 && awcMm > 0) {
      rainGain = Math.min(100, (rainEffective / awcMm) * 100)
      tank += rainGain
      if (rainGain >= 99.5) rainDays.push(date)
    }

    tank = Math.min(100, tank)
    const isPast = date <= today
    if (isPast) currentTank = Math.max(tank, 0)

    steps.push({
      date,
      et0: Math.round(et0 * 100) / 100,
      et0Source: source,
      intervalDays: effectiveInterval,
      modelIntervalDays: correction.modelIntervalDays,
      knowledgeIntervalDays: correction.baseIntervalDays,
      corrected: Boolean(correction.corrected),
      w: interval.w,
      consume: Math.round(consume * 10) / 10,
      rainMm: Math.round(rainMm * 10) / 10,
      rainEffective: Math.round(rainEffective * 10) / 10,
      rainGain: Math.round(rainGain * 10) / 10,
      tank: Math.round(Math.max(tank, 0) * 10) / 10,
      isPast,
      naturalWatering: rainGain >= 99.5
    })

    if (tank <= 0 && !dueDate) {
      dueDate = date
      overdue = isPast
      if (!overdue) break
    }
  }

  // 预报范围内没见底：用最后一天的间隔线性外推
  if (!dueDate) {
    const last = steps[steps.length - 1]
    const lastDate = new Date(last.date)
    const remainingDays = (tank / 100) * last.intervalDays
    const due = new Date(lastDate.getTime() + Math.max(remainingDays, 0.5) * 86400000)
    dueDate = formatDate(due)
    steps.push({
      date: dueDate,
      et0: last.et0,
      et0Source: last.et0Source,
      intervalDays: last.intervalDays,
      modelIntervalDays: last.modelIntervalDays,
      knowledgeIntervalDays: last.knowledgeIntervalDays,
      corrected: last.corrected,
      w: last.w,
      consume: Math.round(remainingDays * 10) / 10,
      rainMm: 0,
      rainEffective: 0,
      rainGain: 0,
      tank: 0,
      isPast: false,
      naturalWatering: false,
      extrapolated: true
    })
  }

  return {
    ok: true,
    nextDueDate: dueDate,
    overdue,
    tankPercent: Math.round(Math.max(tank, 0)),
    // 当前（截至今天）剩余水量，界面上显示这个
    currentTankPercent: Math.round(currentTank),
    naturalWateringDays: rainDays,
    steps,
    lastStep: steps[steps.length - 1]
  }
}

/** 依据模型结果生成给用户看的一句原因 */
function describeReason(result, options = {}) {
  const { indoor = false, floorApplied = false, weatherSource = 'api' } = options
  const parts = []

  if (weatherSource === 'seasonal') {
    parts.push('没取到当地天气，先按季节平均值估算')
  } else if (weatherSource === 'tmax_only') {
    parts.push('天气数据不全，只用最高温估算蒸发量')
  }

  const w = result && result.lastStep ? result.lastStep.w : null
  if (w !== null && w >= 1.5) parts.push('最近蒸发强，水干得快')
  else if (w !== null && w <= 0.6) parts.push('最近蒸发慢，可以少浇一点')

  if (floorApplied) parts.push('室内有暖气或空调，土其实干得不慢')
  if (result && result.naturalWateringDays && result.naturalWateringDays.length) {
    parts.push(`${result.naturalWateringDays.join('、')} 下过雨，相当于浇了一次水，日期已重置`)
  }

  const steps = (result && result.steps) || []
  const rainDays = steps.filter((step) => step.rainGain > 5 && step.rainGain < 99.5)
  if (rainDays.length && !(result.naturalWateringDays || []).length) {
    parts.push('期间有降雨，已把下次浇水往后推')
  }

  if (!parts.length) parts.push('按这盆植物的基准节奏安排')

  // 始终补一句基准说明，避免只出现“按基准节奏”这种没有信息量的结论
  if (result && result.lastStep) {
    const step = result.lastStep
    const month = new Date(step.date).getMonth() + 1
    const seasonName = { 3: '春', 4: '春', 5: '春', 6: '夏', 7: '夏', 8: '夏', 9: '秋', 10: '秋', 11: '秋', 12: '冬', 1: '冬', 2: '冬' }[month] || ''

    if (step.corrected && step.knowledgeIntervalDays) {
      parts.push(`${seasonName}季蒸发约 ${step.et0} mm/天，按这个水平推算是每 ${step.modelIntervalDays} 天一次，` +
        `和知识库的 ${step.knowledgeIntervalDays} 天差得比较多，已折中成每 ${step.intervalDays} 天一次（更偏向当地天气）`)
    } else {
      parts.push(`${seasonName}季蒸发约 ${step.et0} mm/天，按这个水平推算每 ${step.intervalDays} 天一次`)
    }
  }

  return parts.join('；')
}

module.exports = {
  ET0_REF,
  INTERVAL_MIN,
  INTERVAL_MAX,
  INDOOR_ET0_FLOOR,
  SEASONAL_W,
  loadOptions,
  getSoils,
  getPotSpecs,
  getExposures,
  findSoil,
  findPotSpec,
  findExposure,
  getBaseInterval,
  seasonOf,
  seasonalEt0,
  estimateEt0,
  weatherCoefficient,
  computeInterval,
  applyCorrection,
  CORRECTION_TRIGGER_RATIO,
  CORRECTION_MODEL_WEIGHT,
  availableWater,
  projectWatering,
  describeReason,
  formatDate
}
