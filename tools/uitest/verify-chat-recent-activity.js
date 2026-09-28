/**
 * 块 4：AI 花农对话要看得见"用户刚完成过什么"（2026-09-21）
 *
 * 背景：用户在完成面板勾了「花多多1号」，转头问"我上次施肥用的是什么"，
 * 托蕾妮回答"档案里只记了提醒，没记上次用了什么肥，我查不到"——记了却看不见。
 *
 * 要验三件事：
 *   ① 数据层：完成登记（含"实际用了什么"）和养护日记能进对话上下文；
 *   ② 不变量：当时选「说不清」的，上下文里必须是「实际做了什么未登记」，不能被当成"按方案做了"；
 *   ③ AI 层：问"上次用的什么肥"要答出用户勾的那一项；没登记的那次要说"没登记"，不许编。
 *
 * 用法：需要后端在跑（HTTP 部分造数据）。node verify-chat-recent-activity.js
 */
const path = require('node:path')
const { SERVER_DIR, loadEnv, check, checkTruthy, fail, summary } = require('./ai-lib')
const { getToken, api, openDb, createTempPlant, deletePlant, BASE } = require('./lib')

loadEnv()
const gardener = require(path.join(SERVER_DIR, 'src/services/gardener.js'))
const nextReminder = require(path.join(SERVER_DIR, 'src/services/nextReminder.js'))

async function complete(token, reminderId, body) {
  const res = await fetch(BASE + '/reminders/' + reminderId + '/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body || {})
  })
  return { status: res.status, data: await res.json() }
}

async function ask(token, plantId, question) {
  const data = await api('/chat/gardener', {
    method: 'POST',
    body: { plant_id: plantId, message: question }
  }, token)
  return String((data && data.reply) || '')
}

async function waitForReminder(token, plantId, type) {
  for (let i = 0; i < 20; i++) {
    const list = await api('/plants/' + plantId + '/reminders', {}, token)
    const found = (list.reminders || []).find((item) => item.type === type)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error('没等到 ' + type + ' 提醒')
}

function contextFor(db, plantId, message) {
  const plant = db.prepare('SELECT * FROM plants WHERE id = ?').get(plantId)
  return gardener.buildContext(db, plant, message || '')
}

const SPECIFIC_FERTILIZERS = ['花多多', '奥绿', '磷酸二氢钾', '美乐棵', '花宝', '骨粉', '蚯蚓粪']

/** 比字符串时忽略空格：模型会把「花多多1号」写成「花多多 1 号」，这是同一件事 */
function compact(text) {
  return String(text || '').replace(/\s+/g, '')
}

async function main() {
  const token = getToken()
  const db = openDb()
  const question = '我上次施肥用的是什么？'

  // ---- 植物 A：完成时勾了具体肥料 ----
  const plantA = await createTempPlant(token, '对话记录A', '月季')
  // ---- 植物 B：完成时选「说不清」 ----
  const plantB = await createTempPlant(token, '对话记录B', '月季')

  try {
    const fertA = await waitForReminder(token, plantA, 'fertilizing')
    const fertB = await waitForReminder(token, plantB, 'fertilizing')

    console.log('=== ① 数据层：完成登记进得了对话上下文 ===')
    const doneA = await complete(token, fertA.id, {
      done_items: ['花多多1号'],
      occurred_at: new Date().toISOString().slice(0, 10)
    })
    check('完成接口返回 200', doneA.status, 200)
    const ctxA = contextFor(db, plantA, question)
    console.log('  植物A 的【最近发生的事】：')
    ctxA.recentActivity.lines.forEach((line) => console.log('    ' + line))
    checkTruthy('上下文里带上了用户勾的「花多多1号」',
      ctxA.recentActivity.lines.join('\n').indexOf('花多多1号') >= 0)
    checkTruthy('上下文里标了这是已完成（不是计划）',
      ctxA.recentActivity.completionLines.join('\n').indexOf('已完成') >= 0)

    console.log('')
    console.log('=== ② 不变量：「说不清」必须写成「未登记」 ===')
    await complete(token, fertB.id, { unsure: true })
    const ctxB = contextFor(db, plantB, question)
    const textB = ctxB.recentActivity.lines.join('\n')
    console.log('  植物B 的【最近发生的事】：')
    ctxB.recentActivity.lines.forEach((line) => console.log('    ' + line))
    checkTruthy('未登记的那次写成了「实际做了什么未登记」', textB.indexOf('实际做了什么未登记') >= 0)
    check('未登记时不写具体肥名',
      SPECIFIC_FERTILIZERS.find((word) => textB.indexOf(word) >= 0) || '（无）', '（无）')

    console.log('')
    console.log('=== ③ 和「排下一轮提醒」共用同一份口径 ===')
    const historyA = nextReminder.buildHistory(db, plantA).join('\n')
    checkTruthy('两处都能看到同一条完成记录（花多多1号）', historyA.indexOf('花多多1号') >= 0)
    const historyB = nextReminder.buildHistory(db, plantB).join('\n')
    checkTruthy('未登记在两处都是同一句话', historyB.indexOf('实际做了什么未登记') >= 0)

    console.log('')
    console.log('=== ④ 计划类日记不会被当成"已经做过" ===')
    const planDay = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10)
    await api('/plants/' + plantA + '/plan', {
      method: 'POST',
      body: { kind: 'other', title: '给植物买个补光灯', due_at: planDay }
    }, token)
    const ctxA2 = contextFor(db, plantA, question)
    const plannedLine = ctxA2.recentActivity.lines.find((line) => line.indexOf('补光灯') >= 0) || ''
    console.log('  计划那行：' + (plannedLine || '（没有）'))
    checkTruthy('计划写成「已排的计划…还没到日子」', plannedLine.indexOf('还没到日子') >= 0)
    check('计划不写成「已完成」', /已完成.*补光灯/.test(ctxA2.recentActivity.lines.join('\n')), false)
    // 四类外计划不该建提醒，也不该覆盖完成记录
    checkTruthy('完成记录还在（没被计划冲掉）',
      ctxA2.recentActivity.lines.join('\n').indexOf('花多多1号') >= 0)

    console.log('')
    console.log('=== ⑤ AI 层：真的答得上来 ===')
    const replyA = await ask(token, plantA, question)
    console.log('  植物A 的回答：' + replyA.replace(/\s+/g, ' '))
    checkTruthy('回答里说出了用户勾的「花多多1号」', compact(replyA).indexOf(compact('花多多1号')) >= 0)

    const replyB = await ask(token, plantB, question)
    console.log('  植物B 的回答：' + replyB.replace(/\s+/g, ' '))
    // 判据是"不能把它说成事实"，不是"一个字都不许提"：
    // 实测模型会写「我不替你猜名字，比如把花多多 1 号说成 2 号就容易误导」——
    // 那是举例，不是编造用户用过什么。所以查的是"用的是 X"这种断言句式。
    const claims = new RegExp('(用的是|用的就是|使用的是|确实是|就是)\\s*(' +
      SPECIFIC_FERTILIZERS.join('|') + ')')
    const claim = compact(replyB).match(claims)
    check('没登记的那次不会说成"你用的就是某一种肥"',
      claim ? claim[0] : '（无）', '（无）')
    checkTruthy('并且如实说没登记 / 记录里没有',
      /没登记|未登记|没有记录|没记下|查不到|没有留|说不清/.test(replyB))
  } finally {
    db.close()
    await deletePlant(token, plantA).catch(() => {})
    await deletePlant(token, plantB).catch(() => {})
  }

  if (summary() > 0) process.exit(1)
}

main().catch((err) => {
  fail('脚本异常', (err && err.stack) || String(err))
  process.exit(1)
})
