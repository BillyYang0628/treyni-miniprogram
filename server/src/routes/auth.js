const express = require('express')
const { getDb } = require('../db')
const wechatService = require('../services/wechat')
const { createToken } = require('../services/token')
const { getRequestBaseUrl, toPublicUrl, toStoredPath } = require('../services/imageUrl')

const router = express.Router()

function toPublicUser(user, baseUrl) {
  return {
    id: user.id,
    nickname: user.nickname || '',
    avatar_url: toPublicUrl(user.avatar_url, baseUrl),
    created_at: user.created_at
  }
}

router.post('/wechat/login', async (req, res, next) => {
  try {
    const code = req.body && req.body.code
    const nickname = req.body && req.body.nickname
    const avatarUrl = toStoredPath(req.body && req.body.avatar_url)

    if (!code) {
      return res.status(400).json({
        error: '缺少微信登录 code',
        code: 'MISSING_CODE'
      })
    }

    const session = await wechatService.code2Session(code)
    const db = getDb()

    let user = db.prepare('SELECT * FROM users WHERE openid = ?').get(session.openid)

    if (!user) {
      const result = db
        .prepare(`
          INSERT INTO users (openid, unionid, nickname, avatar_url)
          VALUES (?, ?, ?, ?)
        `)
        .run(session.openid, session.unionid || '', nickname || '', avatarUrl || '')
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid)
    } else {
      const fields = []
      const values = []

      if (session.unionid) {
        fields.push('unionid = ?')
        values.push(session.unionid)
      }
      if (nickname) {
        fields.push('nickname = ?')
        values.push(nickname)
      }
      if (avatarUrl) {
        fields.push('avatar_url = ?')
        values.push(avatarUrl)
      }

      if (fields.length) {
        fields.push("updated_at = datetime('now')")
        values.push(user.id)
        db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values)
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)
      }
    }

    const token = createToken(user.id)

    res.json({
      token,
      user: toPublicUser(user, getRequestBaseUrl(req))
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
