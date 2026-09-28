const config = require('./config')
const session = require('./session')

/**
 * 账号口令登录。
 * 账号由管理员在服务端用 tools/admin/create-account.js 生成后私下发放，
 * 客户端没有注册入口，也不提供自助找回。
 */
function login(username, password) {
  return session.loginWithAccount(username, password)
}

/** 退出登录：先让服务端作废这个 token，再清本地并回登录页 */
function logout() {
  const token = session.getToken()
  if (token) {
    wx.request({
      url: config.getBaseUrl() + '/auth/logout',
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token
      },
      timeout: config.timeout,
      complete() {
        session.requireLogin()
      }
    })
    return
  }
  session.requireLogin()
}

function getToken() {
  return session.getToken()
}

module.exports = {
  login,
  logout,
  getToken
}
