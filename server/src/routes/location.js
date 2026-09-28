const express = require('express')
const { getDb } = require('../db')
const { requireAuth } = require('../middleware/auth')
const waterPlan = require('../services/waterPlan')
const subscribeMessage = require('../services/subscribeMessage')
const reminderPush = require('../services/reminderPush')

const router = express.Router()

router.use(requireAuth)

function mapLocation(row) {
  if (!row) return null
  return {
    city: row.city,
    district: row.district || '',
    location_id: row.location_id || '',
    lat: row.lat,
    lon: row.lon,
    source: row.source,
    updated_at: row.updated_at
  }
}

// 当前用户设置的城市
router.get('/users/me/location', (req, res) => {
  res.json({ location: mapLocation(waterPlan.getUserLocation(req.user.id)) })
})

// 城市检索（给小程序做候选列表）
router.get('/weather/city-search', async (req, res, next) => {
  try {
    const keyword = String(req.query.keyword || '').trim()
    if (!keyword) {
      return res.status(400).json({
        error: '请输入城市名称',
        code: 'MISSING_KEYWORD'
      })
    }

    const cities = await waterPlan.searchCity(keyword)
    res.json({ cities })
  } catch (err) {
    next(err)
  }
})

// 设置城市：传城市名或和风 LocationID
router.put('/users/me/location', async (req, res, next) => {
  try {
    const city = String((req.body && req.body.city) || '').trim()
    const locationId = String((req.body && req.body.location_id) || '').trim()
    const lat = Number(req.body && req.body.lat)
    const lon = Number(req.body && req.body.lon)

    if (!city && !locationId) {
      return res.status(400).json({
        error: '请提供城市名称或 location_id',
        code: 'MISSING_CITY'
      })
    }

    let target = null

    if (locationId && Number.isFinite(lat) && Number.isFinite(lon)) {
      target = { city, district: String((req.body && req.body.district) || ''), id: locationId, lat, lon }
    } else {
      const cities = await waterPlan.searchCity(city || locationId)
      target = cities[0]
    }

    waterPlan.saveUserLocation(req.user.id, {
      city: city || target.name,
      district: target.district,
      locationId: target.id,
      lat: target.lat,
      lon: target.lon,
      source: 'manual'
    })

    res.json({ location: mapLocation(waterPlan.getUserLocation(req.user.id)) })
  } catch (err) {
    next(err)
  }
})

// 用当前城市试算一次（给“我的”页面预览，也方便排查）
// 订阅消息配置：小程序端据此决定是否请求订阅授权
router.get('/config/subscribe', (req, res) => {
  const config = require('../config')
  res.json({
    configured: subscribeMessage.isConfigured(),
    template_id: config.wechat.subscribeTemplateId || '',
    scan_ahead_hours: reminderPush.AHEAD_HOURS
  })
})

// 记录用户是否同意订阅（小程序 wx.requestSubscribeMessage 的结果）
router.post('/users/me/subscriptions', (req, res) => {
  const templateId = String((req.body && req.body.template_id) || '').trim()
  const accepted = Boolean(req.body && req.body.accepted)

  if (!templateId) {
    return res.status(400).json({
      error: '缺少 template_id',
      code: 'MISSING_TEMPLATE_ID'
    })
  }

  getDb().prepare(`
    INSERT INTO wx_subscriptions (user_id, template_id, status, accepted_at, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(user_id, template_id) DO UPDATE SET
      status = excluded.status,
      updated_at = datetime('now')
  `).run(req.user.id, templateId, accepted ? 'accepted' : 'rejected')

  res.json({ template_id: templateId, status: accepted ? 'accepted' : 'rejected' })
})

router.get('/users/me/subscriptions', (req, res) => {
  const rows = getDb()
    .prepare('SELECT template_id, status, accepted_at, updated_at FROM wx_subscriptions WHERE user_id = ?')
    .all(req.user.id)

  res.json({ subscriptions: rows })
})

// 手动触发一次推送扫描（便于联调；dry_run=true 时只返回将要发送的文案）
router.post('/reminders/push/run', async (req, res, next) => {
  try {
    const dryRun = Boolean(req.body && req.body.dry_run)
    const withinHours = Number(req.body && req.body.within_hours) || reminderPush.AHEAD_HOURS
    const result = await reminderPush.scan({ dryRun, withinHours })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// 用当前城市试算一次（给“我的”页面预览，也方便排查）
router.get('/weather/current', async (req, res, next) => {
  try {
    const location = waterPlan.getUserLocation(req.user.id)
    if (!location || !location.location_id) {
      return res.status(400).json({
        error: '还没有设置城市',
        code: 'LOCATION_NOT_SET'
      })
    }

    const weather = require('../services/weather')
    const [now, daily, warnings] = await Promise.all([
      weather.getNow(location.location_id),
      weather.getDaily(location.location_id, 3),
      weather.getWarnings(location.lat, location.lon).catch(() => [])
    ])

    res.json({
      location: mapLocation(location),
      now,
      daily,
      warnings
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
