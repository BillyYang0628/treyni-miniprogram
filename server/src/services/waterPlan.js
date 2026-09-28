/**
 * 把天气系数模型接到具体的一盆植物上：
 *  取用户所在城市天气 → 逐日水量平衡 → 给出下次浇水日期与原因
 * 天气拿不到时按文档的季节平均值兜底，并如实标注。
 */
const { getDb } = require('../db')
const weather = require('./weather')
const waterModel = require('./waterModel')
const waterBaseline = require('./waterBaseline')
const reminderTiming = require('./reminderTiming')

const CARE_LABEL = { watering: '浇水', fertilizing: '施肥', pesticide: '打药', pruning: '修剪' }

function todayString() {
  return waterModel.formatDate(new Date())
}

/** 在某个日期上加天数，返回 YYYY-MM-DD */
function addDays(dateString, days) {
  const base = new Date(dateString + 'T00:00:00+08:00')
  return waterModel.formatDate(new Date(base.getTime() + days * 86400000))
}

function getUserLocation(userId) {
  return getDb().prepare('SELECT * FROM user_locations WHERE user_id = ?').get(userId)
}

function saveUserLocation(userId, location) {
  const db = getDb()
  db.prepare(`
    INSERT INTO user_locations (user_id, city, district, location_id, lat, lon, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      city = excluded.city,
      district = excluded.district,
      location_id = excluded.location_id,
      lat = excluded.lat,
      lon = excluded.lon,
      source = excluded.source,
      updated_at = datetime('now')
  `).run(
    userId,
    location.city,
    location.district || '',
    location.locationId || '',
    location.lat || null,
    location.lon || null,
    location.source || 'manual'
  )
}

/** 按城市名检索候选城市（和风 GeoAPI） */
async function searchCity(keyword) {
  return weather.lookupLocation(keyword)
}

/** 这盆植物是否适合用天气模型（食虫、水生等按文档不适用） */
function isModelSupported(plant, knowledge) {
  const options = waterModel.loadOptions()
  if ((options.no_model_species || []).includes(plant.species)) return false
  if (knowledge && (options.no_model_care_groups || []).includes(knowledge.careGroup)) return false
  return true
}

/**
 * 计算一盆植物下次浇水的日期。
 * 返回 { ok, nextDueDate, intervalDays, reason, steps, weatherSource, mode }
 */
async function computeNextWatering(plant, options = {}) {
  const db = getDb()
  const knowledge = options.knowledge
  const base = waterModel.getBaseInterval({
    species: plant.species,
    intervalDays: options.baseIntervalDays || (knowledge ? knowledge.interval_days : null),
    careGroup: knowledge ? knowledge.careGroup : null
  })

  const exposure = waterModel.findExposure(plant.exposure) ||
    waterModel.findExposure('open_balcony')
  const soil = waterModel.findSoil(plant.soil_id || plant.soil_type) ||
    waterModel.findSoil('mixed_unknown')
  const potDepth = Number(plant.pot_depth_mm) || 150
  const awc = waterModel.availableWater(potDepth, soil.w)

  const location = options.location || getUserLocation(plant.user_id)
  const indoor = Boolean(exposure.indoor)

  let daily = []
  let weatherSource = 'seasonal'
  let weatherError = ''
  let usedLocation = location

  if (location && location.location_id) {
    try {
      const forecast = await weather.getDaily(location.location_id, 3)
      let now = null
      try {
        now = await weather.getNow(location.location_id)
      } catch (e) {
        now = null
      }

      const today = todayString()
      // 优先用预报里今天的实测预报值（最高温/最低温/湿度更准），
      // 只有预报缺今天时才用实时数据近似
      daily = forecast.map((day) => ({ ...day }))

      const todayRow = daily.find((item) => item.date === today)
      if (todayRow) {
        if (now) todayRow.rainMm = Math.max(todayRow.rainMm || 0, now.precip || 0)
      } else if (now) {
        daily.unshift({
          date: today,
          tmax: now.temp + 4,
          tmin: now.temp - 5,
          humidity: now.humidity,
          rainMm: now.precip
        })
      }
      weatherSource = 'api'
    } catch (e) {
      weatherError = e.message
      daily = []
    }
  }

  // 天气拿不到：按季节平均值兜底（文档第七节），并如实标注
  if (!daily.length) {
    const today = new Date()
    for (let i = 0; i < 7; i++) {
      const d = new Date(today.getTime() + i * 86400000)
      daily.push({ date: waterModel.formatDate(d), rainMm: 0 })
    }
    weatherSource = 'seasonal'
  }

  const result = waterModel.projectWatering({
    daily,
    i0: base.i0,
    // 知识库的浇水间隔：天气模型与它差得太多时会按修正系数折中
    baseIntervalDays: knowledge ? knowledge.interval_days : null,
    indoor,
    substrateW: soil.w,
    awcMm: awc,
    rainFactor: indoor ? 0 : exposure.rain_factor,
    latitude: usedLocation ? usedLocation.lat : null,
    today: todayString()
  })

  if (!result.ok) {
    const err = new Error(result.error || '天气数据不可用')
    err.code = 'WATER_MODEL_NO_DATA'
    err.status = 502
    throw err
  }

  const reason = waterModel.describeReason(result, {
    indoor,
    floorApplied: Boolean(result.steps[0] && result.steps[0].floorApplied),
    weatherSource
  })

  return {
    ok: true,
    nextDueDate: result.nextDueDate,
    intervalDays: result.steps[0] ? result.steps[0].intervalDays : base.i0,
    modelIntervalDays: result.steps[0] ? result.steps[0].modelIntervalDays : null,
    knowledgeIntervalDays: result.steps[0] ? result.steps[0].knowledgeIntervalDays : null,
    corrected: Boolean(result.steps[0] && result.steps[0].corrected),
    baseInterval: base.i0,
    baseSource: base.source,
    reason,
    weatherSource,
    weatherError,
    city: usedLocation ? usedLocation.city : '',
    soil: soil.name,
    exposure: exposure.name,
    awcMm: awc,
    tankPercent: result.tankPercent,
    currentTankPercent: result.currentTankPercent,
    naturalWateringDays: result.naturalWateringDays,
    steps: result.steps
  }
}

/** 记录一次浇水事件（含当时的实时天气快照） */
async function recordWateringEvent(plant, userId, note) {
  const db = getDb()
  const location = getUserLocation(userId)
  let snapshot = null

  if (location && location.location_id) {
    try {
      snapshot = await weather.getNow(location.location_id)
    } catch (e) {
      snapshot = { error: e.message }
    }
  }

  db.prepare(`
    INSERT INTO plant_water_events (plant_id, user_id, event_type, happened_at, rain_mm, weather_json, note)
    VALUES (?, ?, 'user_watering', ?, ?, ?, ?)
  `).run(
    plant.id,
    userId,
    new Date().toISOString(),
    snapshot && Number.isFinite(snapshot.precip) ? snapshot.precip : null,
    snapshot ? JSON.stringify(snapshot) : null,
    note || ''
  )

  return snapshot
}

/**
 * 把模型算出来的下次浇水日期写回提醒。
 * 只处理“浇水”类提醒；天气拿不到时按季节兜底并标注，不做静默改写。
 */
async function applyToReminder(reminderId) {
  const db = getDb()
  const reminder = db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(reminderId)

  if (!reminder) return { skipped: true, reason: '提醒不存在' }
  if (reminder.type !== 'watering') return { skipped: true, reason: '不是浇水提醒' }

  const plant = db.prepare('SELECT * FROM plants WHERE id = ?').get(reminder.plant_id)
  if (!plant) return { skipped: true, reason: '植物不存在' }

  const knowledge = require('./knowledge').getCareRule(plant.species, 'watering')
  if (!isModelSupported(plant, knowledge)) {
    return { skipped: true, reason: '该植物按文档不使用天气模型' }
  }

  try {
    const plan = await computeNextWatering(plant, { knowledge })
    const today = todayString()

    // 用户确认过土壤状态就用它当锚点，否则退回模型默认的「今天刚浇透」。
    // 没有这一层时，水分账户永远从 100 开始，用户填什么都没用（见 waterBaseline.js 的说明）。
    const baseline = waterBaseline.readBaseline(reminder.meta_json)
    const fromBaseline = baseline
      ? waterBaseline.projectFromBaseline(baseline, plan.steps[0] ? plan.steps[0].intervalDays : plan.intervalDays, today)
      : null

    const nextDueDate = fromBaseline ? addDays(today, fromBaseline.daysLeft) : plan.nextDueDate
    const tankPercent = fromBaseline
      ? fromBaseline.currentPercent
      : (plan.currentTankPercent !== undefined ? plan.currentTankPercent : plan.tankPercent)

    const dueAt = new Date(`${nextDueDate}T09:00:00+08:00`).toISOString()
    const days = Math.max(
      1,
      Math.round((new Date(nextDueDate + 'T00:00:00+08:00') - new Date(today + 'T00:00:00+08:00')) / 86400000)
    )
    const now = new Date().toISOString()
    const cityText = plan.city ? plan.city + '天气' : '当地天气'
    const dueParts = nextDueDate.split('-')
    const summary = `预计 ${Number(dueParts[1])}月${Number(dueParts[2])}日给${plant.name}浇水`

    // 把水分账户等关键结果存进 meta_json，供提醒详情展示
    let meta = {}
    try {
      meta = reminder.meta_json ? JSON.parse(reminder.meta_json) : {}
    } catch (e) {
      meta = {}
    }

    const firstStep = plan.steps[0] || {}
    meta.water = {
      tank_percent: tankPercent,
      next_due_date: nextDueDate,
      interval_days: firstStep.intervalDays || plan.intervalDays,
      model_interval_days: firstStep.modelIntervalDays || plan.modelIntervalDays || null,
      knowledge_interval_days: firstStep.knowledgeIntervalDays || plan.knowledgeIntervalDays || null,
      corrected: Boolean(firstStep.corrected),
      et0: firstStep.et0 || null,
      et0_source: firstStep.et0Source || 'unknown',
      w: firstStep.w || null,
      city: plan.city || '',
      exposure: plan.exposure,
      soil: plan.soil,
      awc_mm: plan.awcMm,
      rain_reset_days: plan.naturalWateringDays || [],
      weather_source: plan.weatherSource,
      computed_at: now,
      // 有基准时把推算过程也存下来，页面可以如实告诉用户这个数字是怎么来的
      baseline: baseline || null,
      from_baseline: Boolean(fromBaseline),
      baseline_days_since: fromBaseline ? fromBaseline.daysSince : null,
      baseline_daily_use: fromBaseline ? fromBaseline.dailyUse : null
    }

    db.prepare(`
      UPDATE plant_reminders
      SET due_at = ?, interval_days = ?, summary_text = ?,
          ai_model = 'water_model', ai_generated_at = ?, ai_status = 'done',
          ai_error = NULL, ai_reason = ?, meta_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      dueAt,
      days,
      summary,
      now,
      fromBaseline
        ? `${cityText}：${plan.exposure}，${plan.soil}；` +
          `你 ${baseline.date} 确认土壤「${baseline.label}」，之后每天消耗约 ${fromBaseline.dailyUse}%，` +
          `现在还剩约 ${fromBaseline.currentPercent}%（${plan.reason}）`
        : `${cityText}：${plan.reason}（${plan.exposure}，${plan.soil}）`,
      JSON.stringify(meta),
      now,
      reminderId
    )

    // 天气模型重算过日期，阈值按当前间隔重新冻结
    reminderTiming.freezeTiming(db, reminderId)

    return { updated: true, plan }
  } catch (err) {
    db.prepare(`
      UPDATE plant_reminders
      SET ai_status = 'failed', ai_error = ?, updated_at = ?
      WHERE id = ?
    `).run(String(err.message).slice(0, 300), new Date().toISOString(), reminderId)

    throw err
  }
}

/**
 * 写入或更新土壤水分基准，并立刻按新基准重算这盆的浇水安排。
 * @param {number} reminderId 浇水提醒 id
 * @param {string} level      soaked / wet / half / dry / rained
 * @param {string} source     来源，user（页面选）/ feedback（重新生成时填的）/ chat（AI 花农说的）
 */
/**
 * 只写基准、不重算（同步）。
 *
 * 为什么需要同步版本：完成浇水提醒时要**先**按实际完成日期把基准写好，
 * 再让 applyToReminder 去算下一轮——顺序反了算出来的还是旧基准的结果。
 */
function writeBaseline(db, reminderId, level, date, source) {
  const reminder = db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(reminderId)
  if (!reminder || reminder.type !== 'watering') return null
  if (!waterBaseline.isLevel(level)) return null

  let meta = {}
  try {
    meta = reminder.meta_json ? JSON.parse(reminder.meta_json) : {}
  } catch (e) {
    meta = {}
  }

  const baseline = waterBaseline.buildBaseline(level, date || todayString(), source || 'user')
  meta.water_baseline = baseline

  db.prepare('UPDATE plant_reminders SET meta_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(meta),
    new Date().toISOString(),
    reminderId
  )

  return baseline
}

async function setWaterBaseline(reminderId, level, source) {
  const db = getDb()
  const reminder = db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(reminderId)

  if (!reminder) return { ok: false, error: '提醒不存在' }
  if (reminder.type !== 'watering') return { ok: false, error: '不是浇水提醒，不需要土壤水分基准' }
  if (!waterBaseline.isLevel(level)) return { ok: false, error: '不认识的土壤状态：' + level }

  const baseline = writeBaseline(db, reminderId, level, todayString(), source)
  if (!baseline) return { ok: false, error: '写入土壤水分基准失败' }

  // 基准本身是用户给的输入，先落库；重算失败（比如天气接口挂了）也不回滚，
  // 只是告诉调用方一声，下次重算会带上这个基准。
  let plan = null
  let warning = ''
  try {
    const result = await applyToReminder(reminderId)
    plan = result.plan || null
  } catch (err) {
    warning = '基准已保存，但重算下次浇水日期失败：' + err.message
  }

  return { ok: true, baseline, plan, warning }
}

/** 按植物找它当前那条浇水提醒，再写基准（AI 花农是按植物说话的） */
async function setWaterBaselineForPlant(plantId, level, source) {
  const db = getDb()
  const reminder = db
    .prepare("SELECT * FROM plant_reminders WHERE plant_id = ? AND type = 'watering' ORDER BY id DESC LIMIT 1")
    .get(plantId)

  if (!reminder) return { ok: false, error: '这盆植物还没有浇水提醒' }
  return setWaterBaseline(reminder.id, level, source)
}

module.exports = {
  CARE_LABEL,
  getUserLocation,
  saveUserLocation,
  searchCity,
  isModelSupported,
  computeNextWatering,
  recordWateringEvent,
  applyToReminder,
  writeBaseline,
  setWaterBaseline,
  setWaterBaselineForPlant
}
