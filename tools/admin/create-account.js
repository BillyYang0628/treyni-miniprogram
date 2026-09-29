#!/usr/bin/env node
/**
 * 账号管理命令行（唯一能开出账号的地方）
 *
 *   node tools/admin/create-account.js new                  新建 1 个账号
 *   node tools/admin/create-account.js new --count=5        批量建 5 个
 *   node tools/admin/create-account.js new --note="给张老师"  记个备注（存成 nickname）
 *   node tools/admin/create-account.js list                 列出全部账号
 *   node tools/admin/create-account.js reset <账号>          重置口令
 *   node tools/admin/create-account.js disable <账号>        停用（登录直接被拒）
 *   node tools/admin/create-account.js enable <账号>         重新启用
 *
 * 生成结果会追加到 tools/gen/accounts.tsv（该目录不入库），口令只在生成时打印一次。
 */
const fs = require('node:fs')
const path = require('node:path')
const { getDb } = require('../../server/src/db')
const account = require('../../server/src/services/account')

const LEDGER = path.resolve(__dirname, '../gen/accounts.tsv')

function argValue(key) {
  const prefix = '--' + key + '='
  const found = process.argv.find((item) => item.indexOf(prefix) === 0)
  return found ? found.slice(prefix.length) : ''
}

function appendLedger(row) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true })
  if (!fs.existsSync(LEDGER)) {
    fs.writeFileSync(LEDGER, 'created_at\tusername\tpassword\tnote\n', 'utf8')
  }
  fs.appendFileSync(
    LEDGER,
    [row.createdAt, row.username, row.password, row.note].join('\t') + '\n',
    'utf8'
  )
}

function createOne(db, note) {
  const exists = (candidate) =>
    Boolean(db.prepare('SELECT id FROM users WHERE username = ?').get(candidate))

  const username = account.generateUsername(exists)
  const password = account.generatePassword()

  db.prepare(`
    INSERT INTO users (openid, unionid, nickname, avatar_url, username, password_hash, status)
    VALUES (?, '', ?, '', ?, ?, 'active')
  `).run('account:' + username, note || '账号用户', username, account.hashPassword(password))

  return { username, password, note: note || '', createdAt: new Date().toISOString() }
}

function commandNew(db) {
  const count = Math.max(1, Number(argValue('count') || 1))
  const note = argValue('note')
  const created = []

  for (let i = 0; i < count; i += 1) {
    const row = createOne(db, note)
    appendLedger(row)
    created.push(row)
  }

  console.log('\n新建 ' + created.length + ' 个账号（口令只显示这一次，请立刻发给使用者）：\n')
  for (const row of created) {
    console.log('  账号：' + row.username + '    口令：' + row.password + (row.note ? '    （' + row.note + '）' : ''))
  }
  console.log('\n已追加到 ' + LEDGER)
}

function commandList(db) {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.status, u.nickname, u.created_at, u.last_login_at,
           (SELECT COUNT(*) FROM plants p WHERE p.user_id = u.id) AS plants
    FROM users u
    WHERE u.username IS NOT NULL
    ORDER BY u.id
  `).all()

  if (!rows.length) {
    console.log('还没有账号，用 new 建一个。')
    return
  }

  console.log('\n账号                     状态     植物  最近登录              备注')
  console.log('-'.repeat(88))
  for (const row of rows) {
    console.log(
      String(row.username).padEnd(22) + '  ' +
      String(row.status || 'active').padEnd(6) + '  ' +
      String(row.plants).padStart(3) + '   ' +
      String(row.last_login_at || '—').padEnd(20) + '  ' +
      (row.nickname || '')
    )
  }
  console.log('')
}

function findUser(db, username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').toLowerCase())
}

function commandReset(db, username) {
  const user = findUser(db, username)
  if (!user) throw new Error('找不到账号：' + username)

  const password = account.generatePassword()
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .run(account.hashPassword(password), user.id)

  appendLedger({ createdAt: new Date().toISOString(), username: user.username, password, note: '重置口令' })
  console.log('\n账号 ' + user.username + ' 的新口令：' + password + '\n（旧口令立即失效）')
}

function commandSetStatus(db, username, status) {
  const user = findUser(db, username)
  if (!user) throw new Error('找不到账号：' + username)
  db.prepare("UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, user.id)
  console.log('账号 ' + user.username + ' 已设为 ' + status)
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  const db = getDb()

  switch (command) {
    case 'new':
      commandNew(db)
      break
    case 'list':
      commandList(db)
      break
    case 'reset':
      commandReset(db, rest[0])
      break
    case 'disable':
      commandSetStatus(db, rest[0], 'disabled')
      break
    case 'enable':
      commandSetStatus(db, rest[0], 'active')
      break
    default:
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').trim())
  }
}

try {
  main()
} catch (err) {
  console.error('失败：' + err.message)
  process.exit(1)
}
