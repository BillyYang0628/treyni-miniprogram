/**
 * 微信接口调用凭证 access_token
 * 小程序后台的 appid/appsecret 已在 .env 配置；token 有效期 7200 秒，这里缓存并提前刷新。
 */
const config = require('../config')

const REFRESH_AHEAD_MS = 5 * 60 * 1000

let cached = null

function assertConfigured() {
  if (!config.wechat.appid || !config.wechat.secret) {
    const err = new Error('微信小程序未配置，请检查 WECHAT_APPID 与 WECHAT_SECRET')
    err.code = 'WECHAT_NOT_CONFIGURED'
    err.status = 503
    throw err
  }
}

async function fetchAccessToken() {
  assertConfigured()

  const url = new URL('https://api.weixin.qq.com/cgi-bin/token')
  url.searchParams.set('grant_type', 'client_credential')
  url.searchParams.set('appid', config.wechat.appid)
  url.searchParams.set('secret', config.wechat.secret)

  const response = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(10000)
  })
  const data = await response.json()

  if (!data.access_token) {
    const err = new Error(
      '获取微信 access_token 失败：' + (data.errcode || '') + ' ' + (data.errmsg || '')
    )
    err.code = 'WECHAT_TOKEN_FAILED'
    err.status = 502
    throw err
  }

  return {
    token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 7200) * 1000
  }
}

async function getAccessToken() {
  if (cached && cached.expiresAt - REFRESH_AHEAD_MS > Date.now()) {
    return cached.token
  }

  cached = await fetchAccessToken()
  return cached.token
}

function clearCache() {
  cached = null
}

function getCacheInfo() {
  if (!cached) return { cached: false }
  return {
    cached: true,
    expiresInSeconds: Math.max(0, Math.round((cached.expiresAt - Date.now()) / 1000))
  }
}

module.exports = {
  getAccessToken,
  clearCache,
  getCacheInfo,
  assertConfigured
}
