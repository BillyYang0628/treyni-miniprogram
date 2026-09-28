const { getDb } = require('../db')
const { hashToken } = require('../services/token')

function requireAuth(req, res, next) {
  const header = req.get('authorization') || ''
  const token = header.replace(/^Bearer\s+/i, '').trim()

  if (!token) {
    return res.status(401).json({
      error: '请先登录',
      code: 'UNAUTHORIZED'
    })
  }

  const db = getDb()
  const user = db
    .prepare(`
      SELECT
        users.id,
        users.openid,
        users.unionid,
        users.nickname,
        users.avatar_url,
        users.created_at,
        users.updated_at
      FROM auth_tokens
      INNER JOIN users ON users.id = auth_tokens.user_id
      WHERE auth_tokens.token_hash = ? AND auth_tokens.expires_at > ?
    `)
    .get(hashToken(token), new Date().toISOString())

  if (!user) {
    return res.status(401).json({
      error: '登录已过期，请重新登录',
      code: 'TOKEN_EXPIRED'
    })
  }

  req.user = user
  next()
}

module.exports = {
  requireAuth
}
