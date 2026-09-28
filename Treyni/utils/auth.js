const session = require('./session')

/**
 * 「我的」页的登录按钮走这里。
 * 真正的换 token 逻辑在 utils/session.js——登录态过期时 request.js 也会用它自动重登，
 * 两边共用一份实现，避免以后改一处忘一处。
 */
function login(profile = {}) {
  return session.requestToken(profile)
}

function logout() {
  session.clear()
}

function getToken() {
  return session.getToken()
}

module.exports = {
  login,
  logout,
  getToken
}
