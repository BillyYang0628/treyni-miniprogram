/**
 * 和风天气客户端
 * 账号需要自己的 API Host（形如 xxxx.re.qweatherapi.com），配置在 server/.env：
 *   QWEATHER_API_HOST=xxxx.re.qweatherapi.com
 *   QWEATHER_KEY=你的key
 * 没配置或调用失败时抛出明确错误，由上层显式暴露，不做静默兜底。
 */
const config = require('../config')

const CACHE_TTL_MS = 30 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10000

const cache = new Map()

function assertConfigured() {
  const { apiHost, key } = config.qweather
  if (!apiHost || !key) {
    const err = new Error('和风天气未配置，请在 server/.env 填写 QWEATHER_API_HOST 与 QWEATHER_KEY')
    err.code = 'WEATHER_NOT_CONFIGURED'
    err.status = 503
    throw err
  }
}

function baseUrl() {
  const host = String(config.qweather.apiHost || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
  return `https://${host}`
}

async function request(pathname, params = {}) {
  assertConfigured()

  const url = new URL(baseUrl() + pathname)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  }
  url.searchParams.set('key', config.qweather.key)

  const cacheKey = url.toString().replace(config.qweather.key, 'key')
  const cached = cache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.data

  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (e) {
    const err = new Error('和风天气请求失败：' + e.message)
    err.code = 'WEATHER_REQUEST_FAILED'
    err.status = 502
    throw err
  }

  const text = await response.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch (e) {
    const err = new Error('和风天气返回内容无法解析：' + text.slice(0, 120))
    err.code = 'WEATHER_BAD_RESPONSE'
    err.status = 502
    throw err
  }

  if (!response.ok || (data.code && data.code !== '200')) {
    const err = new Error(
      '和风天气接口错误：' + (data.code || response.status) + ' ' + (data.message || data.detail || '')
    )
    err.code = 'WEATHER_API_' + (data.code || response.status)
    err.status = 502
    throw err
  }

  cache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS })
  return data
}

/** 城市/经纬度 → 和风 LocationID */
async function lookupLocation(keyword) {
  const data = await request('/geo/v2/city/lookup', { location: keyword, number: 5 })
  const list = data.location || []

  if (!list.length) {
    const err = new Error('没有找到这个城市：' + keyword)
    err.code = 'WEATHER_CITY_NOT_FOUND'
    err.status = 404
    throw err
  }

  return list.map((item) => ({
    id: item.id,
    name: item.name,
    district: item.adm2 || item.adm1 || '',
    province: item.adm1 || '',
    country: item.country || '',
    lat: Number(item.lat),
    lon: Number(item.lon)
  }))
}

/** 实时天气（用户点“完成浇水”时记录快照） */
async function getNow(locationId) {
  const data = await request('/v7/weather/now', { location: locationId })
  const now = data.now || {}

  return {
    observedAt: now.obsTime || new Date().toISOString(),
    text: now.text || '',
    temp: Number(now.temp),
    humidity: Number(now.humidity),
    precip: Number(now.precip) || 0,
    windSpeed: Number(now.windSpeed) || 0,
    pressure: Number(now.pressure) || null,
    vis: Number(now.vis) || null
  }
}

/** 逐天预报：tmax / tmin / humidity / precip / wind / uv */
async function getDaily(locationId, days = 3) {
  const pathname = days >= 7 ? '/v7/weather/7d' : (days >= 3 ? '/v7/weather/3d' : '/v7/weather/3d')
  const data = await request(pathname, { location: locationId })

  return (data.daily || []).map((item) => ({
    date: item.fxDate,
    textDay: item.textDay || '',
    tmax: Number(item.tempMax),
    tmin: Number(item.tempMin),
    humidity: Number(item.humidity),
    rainMm: Number(item.precip) || 0,
    windSpeed: Number(item.windSpeedDay) || 0,
    uvIndex: Number(item.uvIndex) || null
  }))
}

/** 逐小时预报（判断降雨持续时间与强度） */
async function getHourly(locationId) {
  const data = await request('/v7/weather/24h', { location: locationId })

  return (data.hourly || []).map((item) => ({
    time: item.fxTime,
    temp: Number(item.temp),
    humidity: Number(item.humidity),
    rainMm: Number(item.precip) || 0,
    pop: Number(item.pop) || 0,
    text: item.text || ''
  }))
}

/**
 * 天气预警（新版接口，旧的 /v7/warning/now 已废弃）
 * 使用经纬度：/weatheralert/v1/current/{lat}/{lon}
 */
async function getWarnings(lat, lon) {
  const data = await request(`/weatheralert/v1/current/${lat}/${lon}`)
  const alerts = data.alerts || []

  return alerts.map((item) => ({
    id: item.id || '',
    title: item.title || item.headline || '',
    type: item.typeName || item.type || '',
    level: item.severityColor || item.severity || '',
    urgency: item.urgency || '',
    publishedAt: item.pubTime || '',
    text: item.text || item.description || ''
  }))
}

function getCacheStats() {
  return { size: cache.size }
}

function clearCache() {
  cache.clear()
}

module.exports = {
  CACHE_TTL_MS,
  lookupLocation,
  getNow,
  getDaily,
  getHourly,
  getWarnings,
  getCacheStats,
  clearCache,
  assertConfigured
}
