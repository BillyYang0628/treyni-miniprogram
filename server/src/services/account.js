// 账号口令：只由 tools/admin 下的命令行生成，用户端不提供注册入口。
//
// 口令用 scrypt 加盐哈希后存库（格式 scrypt$N$r$p$salt$hash），
// 校验走 timingSafeEqual；登录失败按「账号 + 来源 IP」计数，连续失败多了就短暂锁定，
// 免得账号被在线爆破——毕竟这套账号是私下发放的，没有第二道防线。
const crypto = require('node:crypto')

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

// 生成用的字符集故意去掉了 0/O、1/l/I 这类看打印件容易认错的字符
const USER_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'

const MAX_FAILURES = 5
const LOCK_MS = 10 * 60 * 1000

const failures = new Map()

function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex')
  const key = crypto.scryptSync(String(password), useSalt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p
  })
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${useSalt}$${key.toString('hex')}`
}

function verifyPassword(password, stored) {
  if (!password || !stored) return false
  const parts = String(stored).split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const [, n, r, p, salt, expected] = parts
  let key
  try {
    key = crypto.scryptSync(String(password), salt, expected.length / 2, {
      N: Number(n),
      r: Number(r),
      p: Number(p)
    })
  } catch (err) {
    return false
  }

  const expectedBuffer = Buffer.from(expected, 'hex')
  if (expectedBuffer.length !== key.length) return false
  return crypto.timingSafeEqual(expectedBuffer, key)
}

function randomFrom(alphabet, length) {
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += alphabet[crypto.randomInt(alphabet.length)]
  }
  return out
}

/** 生成一个没被占用的账号，形如 treyni-k7m2q */
function generateUsername(exists) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = 'treyni-' + randomFrom(USER_ALPHABET, 5)
    if (!exists(candidate)) return candidate
  }
  throw new Error('生成的账号连续撞名，请重试')
}

/** 生成口令：保证至少各有一个字母和一个数字 */
function generatePassword(length = 12) {
  while (true) {
    const candidate = randomFrom(PASSWORD_ALPHABET, length)
    if (/[a-z]/i.test(candidate) && /\d/.test(candidate)) return candidate
  }
}

function attemptKey(username, ip) {
  return String(username || '') + '|' + String(ip || '')
}

/** 还要等多少毫秒才能再试；0 表示可以试 */
function loginLockRemaining(username, ip) {
  const record = failures.get(attemptKey(username, ip))
  if (!record) return 0
  const remaining = record.lockedUntil - Date.now()
  if (remaining <= 0) {
    failures.delete(attemptKey(username, ip))
    return 0
  }
  return remaining
}

function registerFailure(username, ip) {
  const key = attemptKey(username, ip)
  const record = failures.get(key) || { count: 0, lockedUntil: 0 }
  record.count += 1
  if (record.count >= MAX_FAILURES) record.lockedUntil = Date.now() + LOCK_MS
  failures.set(key, record)
  return record
}

function clearFailures(username, ip) {
  failures.delete(attemptKey(username, ip))
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateUsername,
  generatePassword,
  loginLockRemaining,
  registerFailure,
  clearFailures,
  MAX_FAILURES,
  LOCK_MS
}
