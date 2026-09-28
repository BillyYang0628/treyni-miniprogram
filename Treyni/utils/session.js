const config = require('./config')

/**
 * 登录态。
 *
 * 背景（2026-09-18）：后端发的 token 有效期 7 天（AUTH_TOKEN_TTL_MS=604800000）。
 * 手机里的 token 是 9-10 登录时发的，9-17 过期，之后每个请求都返回 401
 * 「登录已过期，请重新登录」——而小程序这边完全没处理：不清理、不重登、不提示，
 * 用户只能干看着报错。
 *
 * 现在：401 时自动清掉旧 token，用 wx.login 静默换一个新的，再重发请求。
 * wx.login 不需要用户授权、不弹窗，所以整个过程用户是无感的。
 *
 * 注意：这里用的是原始 wx.request，不走 utils/request——
 * 否则 request 401 → 重登 → 走 request → 401 会绕成循环依赖。
 */

// 并发请求同时 401 时，只发起一次登录，其余共用同一个 Promise
let inflight = null

function getToken() {
  try {
    return wx.getStorageSync('token') || ''
  } catch (e) {
    return ''
  }
}

function saveSession(data) {
  wx.setStorageSync('token', data.token)
  wx.setStorageSync('userInfo', data.user)
}

function clear() {
  try {
    wx.removeStorageSync('token')
    wx.removeStorageSync('userInfo')
  } catch (e) {
    // 清缓存失败不影响后续流程
  }
}

/** 用 wx.login 的 code 换后端 token */
function requestToken(profile) {
  const extra = profile || {}

  return new Promise((resolve, reject) => {
    wx.login({
      success(res) {
        if (!res.code) {
          reject(new Error('微信登录失败：没拿到 code'))
          return
        }

        wx.request({
          url: config.getBaseUrl() + '/auth/wechat/login',
          method: 'POST',
          header: { 'Content-Type': 'application/json' },
          timeout: config.timeout,
          data: {
            code: res.code,
            nickname: extra.nickname || '',
            avatar_url: extra.avatar_url || ''
          },
          success(r) {
            if (r.statusCode >= 200 && r.statusCode < 300 && r.data && r.data.token) {
              saveSession(r.data)
              resolve(r.data)
            } else {
              reject(new Error((r.data && r.data.error) || '登录失败'))
            }
          },
          fail(err) {
            reject(new Error((err && err.errMsg) || '登录请求失败'))
          }
        })
      },
      fail(err) {
        reject(new Error((err && err.errMsg) || '微信登录失败'))
      }
    })
  })
}

/** 静默重新登录（登录态过期时自动调用） */
function reLogin(profile) {
  if (!inflight) {
    inflight = requestToken(profile).then(
      (data) => {
        inflight = null
        return data
      },
      (err) => {
        inflight = null
        throw err
      }
    )
  }
  return inflight
}

module.exports = {
  getToken,
  clear,
  requestToken,
  reLogin
}
