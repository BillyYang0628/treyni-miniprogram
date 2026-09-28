const config = require('./config')

/**
 * 登录态。
 *
 * 2026-09-28 起改用「账号口令」：账号只能由 tools/admin/create-account.js 生成，
 * 私下发放给使用者，客户端没有注册入口，也没有微信静默登录。
 *
 * 因此 401 不再有"自动续期"这条路：旧 token 一律清掉并回到登录页，
 * 由使用者自己重新输入账号口令。
 *
 * 注意：这里用的是原始 wx.request，不走 utils/request——
 * 否则 request 401 → 回登录页 → 走 request → 401 会绕成循环依赖。
 */

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

/** 账号口令登录（后端 POST /auth/login） */
function loginWithAccount(username, password) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: config.getBaseUrl() + '/auth/login',
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      timeout: config.timeout,
      data: {
        username: String(username || '').trim(),
        password: String(password || '')
      },
      success(r) {
        if (r.statusCode >= 200 && r.statusCode < 300 && r.data && r.data.token) {
          saveSession(r.data)
          resolve(r.data)
          return
        }
        reject(new Error((r.data && r.data.error) || '登录失败'))
      },
      fail(err) {
        reject(new Error((err && err.errMsg) || '登录请求失败'))
      }
    })
  })
}

/**
 * 登录态不可用：清掉本地凭据并回到登录页。
 * 已经在登录页上就不再跳，免得 reLaunch 打转。
 */
function requireLogin() {
  clear()
  try {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    const current = pages.length ? pages[pages.length - 1].route : ''
    if (current === 'pages/login/login') return
  } catch (e) {
    // 取不到页面栈时按需要跳转处理
  }
  wx.reLaunch({ url: '/pages/login/login' })
}

module.exports = {
  getToken,
  saveSession,
  clear,
  loginWithAccount,
  requireLogin
}
