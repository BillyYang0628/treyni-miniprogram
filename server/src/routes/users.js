const express = require('express')
const { getDb } = require('../db')
const { requireAuth } = require('../middleware/auth')
const { getRequestBaseUrl, toPublicUrl, toStoredPath } = require('../services/imageUrl')

const router = express.Router()

router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      nickname: req.user.nickname || '',
      avatar_url: toPublicUrl(req.user.avatar_url, getRequestBaseUrl(req)),
      created_at: req.user.created_at
    }
  })
})

router.put('/me', requireAuth, (req, res) => {
  const nickname = req.body && req.body.nickname
  const avatarUrl = req.body && req.body.avatar_url
  const fields = []
  const values = []

  if (nickname !== undefined) {
    fields.push('nickname = ?')
    values.push(nickname)
  }
  if (avatarUrl !== undefined) {
    fields.push('avatar_url = ?')
    values.push(toStoredPath(avatarUrl))
  }

  if (!fields.length) {
    return res.status(400).json({
      error: '没有需要更新的字段',
      code: 'NOTHING_TO_UPDATE'
    })
  }

  const db = getDb()
  fields.push("updated_at = datetime('now')")
  values.push(req.user.id)
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values)

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)
  res.json({
    user: {
      id: user.id,
      nickname: user.nickname || '',
      avatar_url: toPublicUrl(user.avatar_url, getRequestBaseUrl(req)),
      created_at: user.created_at
    }
  })
})

module.exports = router
