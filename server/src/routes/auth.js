const express = require('express')
const config = require('../config')
const { getDb } = require('../db')
const wechatService = require('../services/wechat')
const account = require('../services/account')
const { createToken, revokeToken } = require('../services/token')
const { getRequestBaseUrl, toPublicUrl, toStoredPath } = require('../services/imageUrl')

const router = express.Router()

function toPublicUser(user, baseUrl) {
  return {
    id: user.id,
    username: user.username || '',
    nickname: user.nickname || '',
    avatar_url: toPublicUrl(user.avatar_url, baseUrl),
    created_at: user.created_at
  }
}

/**
 * 账号口令登录。
 * 账号只能由 tools/admin 下的命令行生成，客户端没有注册入口；
 * 只有拿到发放出去的账号口令才能进主界面。
 */
router.post('/login', (req, res, next) => {
  try {
    const username = String((req.body && req.body.username) || '').trim().toLowerCase()
    const password = String((req.body && req.body.password) || '')

    if (!username || !password) {
      return res.status(400).json({ error: '请输入账号和密码', code: 'MISSING_CREDENTIALS' })
    }

    const lockRemaining = account.loginLockRemaining(username, req.ip)
    if (lockRemaining > 0) {
      return res.status(429).json({
        error: '尝试次数过多，请 ' + Math.ceil(lockRemaining / 60000) + ' 分钟后再试',
        code: 'TOO_MANY_ATTEMPTS'
      })
    }

    const db = getDb()
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username)

    if (!user || user.status === 'disabled' || !account.verifyPassword(password, user.password_hash)) {
      account.registerFailure(username, req.ip)
      return res.status(401).json({ error: '账号或密码不正确', code: 'BAD_CREDENTIALS' })
    }

    account.clearFailures(username, req.ip)
    db.prepare("UPDATE users SET last_login_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(user.id)

    res.json({
      token: createToken(user.id),
      user: toPublicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id), getRequestBaseUrl(req))
    })
  } catch (err) {
    next(err)
  }
})

router.post('/logout', (req, res) => {
  const header = req.headers.authorization || ''
  const token = header.indexOf('Bearer ') === 0 ? header.slice(7).trim() : ''
  revokeToken(token)
  res.json({ ok: true })
})

router.post('/wechat/login', async (req, res, next) => {
  try {
    // 微信登录默认关闭：这套小程序走的是私下发放的账号口令。
    // 本地要调微信链路时，在 server/.env 里设 AUTH_ALLOW_WECHAT=true。
    if (!config.auth.allowWechat) {
      return res.status(403).json({ error: '微信登录已关闭', code: 'WECHAT_LOGIN_DISABLED' })
    }

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
