const crypto = require('node:crypto')
const { getDb } = require('../db')
const config = require('../config')

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function createToken(userId) {
  const db = getDb()
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + config.authTokenTtlMs).toISOString()

  db.prepare('INSERT INTO auth_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(
    userId,
    hashToken(token),
    expiresAt
  )

  return token
}

function revokeToken(token) {
  if (!token) return
  const db = getDb()
  db.prepare('DELETE FROM auth_tokens WHERE token_hash = ?').run(hashToken(token))
}

module.exports = {
  createToken,
  revokeToken,
  hashToken
}
