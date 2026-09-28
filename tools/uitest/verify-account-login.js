// 账号口令登录的端到端回归。
//
// 覆盖：
//  1) 没登录态时启动 → 落在登录页（不是花园页）
//  2) 正确账号口令 → 进花园页，且拿到可用 token
//  3) 错误口令 → 停在登录页并提示
//  4) 后端 /auth/wechat/login 已关闭（不再有微信静默登录这条路）
//  5) 退出登录后 token 失效，接口返回 401
//
// 自己建临时账号，跑完删掉。
const automator = require('miniprogram-automator')
const path = require('node:path')
const fs = require('node:fs')
const { getDb } = require('../../server/src/db')
const account = require('../../server/src/services/account')
const { BASE } = require('./lib')

const SHOT_DIR = path.resolve(__dirname, 'shots-art')

let passed = 0
let failed = 0

function check(label, actual, expected) {
  const ok = String(actual) === String(expected)
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (ok) passed += 1
  else failed += 1
  return ok
}

async function rawLogin(username, password) {
  const res = await fetch(BASE + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  return { status: res.status, data: await res.json().catch(() => null) }
}

async function main() {
  const db = getDb()
  const exists = (candidate) => Boolean(db.prepare('SELECT id FROM users WHERE username = ?').get(candidate))
  const username = account.generateUsername(exists)
  const password = account.generatePassword()
  db.prepare(`
    INSERT INTO users (openid, unionid, nickname, avatar_url, username, password_hash, status)
    VALUES (?, '', '回归临时账号', '', ?, ?, 'active')
  `).run('account:' + username, username, account.hashPassword(password))
  const userId = db.prepare('SELECT id FROM users WHERE username = ?').get(username).id

  let miniProgram = null
  try {
    // 4) 微信登录入口必须已经关闭
    const wechat = await fetch(BASE + '/auth/wechat/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    })
    check('微信登录入口已关闭', wechat.status, 403)

    miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
    // 开发者工具刚打开时页面还在编译，等它稳定再操作（automator 0.12.1 会直接报 timeout）
    await (await miniProgram.currentPage()).waitFor(3000)

    // 1) 清掉本地登录态后重启，应落在登录页
    await miniProgram.callWxMethod('removeStorageSync', 'token')
    await miniProgram.callWxMethod('removeStorageSync', 'userInfo')
    await miniProgram.reLaunch('/pages/login/login')
    let page = await miniProgram.currentPage()
    await page.waitFor(1200)
    check('无登录态时的页面', page.path, 'pages/login/login')
    await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'login.png') })

    // 3) 错误口令：不能登录成功（页面是否显示红字，用截图核，不靠读 data）
    await page.setData({ username, password: 'definitely-wrong' })
    await page.callMethod('onSubmit')
    await page.waitFor(2500)
    page = await miniProgram.currentPage()
    const errorText = (page.data && page.data.error) || ''
    console.log('    错误提示原文: ' + JSON.stringify(errorText))
    check('错误口令后仍在登录页', page.path, 'pages/login/login')
    const leftover = await miniProgram.callWxMethod('getStorageSync', 'token')
    check('错误口令没有留下 token', Boolean(leftover), false)
    await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'login-error.png') })

    // 2) 正确口令：跳花园页，token 可用
    await page.setData({ username, password })
    await page.callMethod('onSubmit')
    await page.waitFor(2500)
    page = await miniProgram.currentPage()
    check('登录成功后的页面', page.path, 'pages/garden/garden')

    const token = await miniProgram.callWxMethod('getStorageSync', 'token')
    check('本地已存 token', Boolean(token), true)

    const garden = await fetch(BASE + '/plants', { headers: { Authorization: 'Bearer ' + token } })
    check('token 能读接口', garden.status, 200)

    // 5) 退出登录后 token 应该失效
    await fetch(BASE + '/auth/logout', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token }
    })
    const afterLogout = await fetch(BASE + '/plants', { headers: { Authorization: 'Bearer ' + token } })
    check('退出后 token 失效', afterLogout.status, 401)

    // 顺手再验一次直接调接口的那条路（不经过小程序）
    const direct = await rawLogin(username, password)
    check('接口直连登录', direct.status, 200)
  } finally {
    if (miniProgram) await miniProgram.close().catch(() => {})
    db.prepare('DELETE FROM users WHERE id = ?').run(userId)
    db.close()
  }

  console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项')
  if (failed) process.exit(1)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
