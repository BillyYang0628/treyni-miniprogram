/**
 * B-2：完成面板对话化（批注 3）
 *
 * 要验四件事：
 *   ① 服务端造句接口：返回一句人话、不含建议词、不超长（含耗时实测）
 *   ② 勾 2 项提交 → 面板里出现「我」的气泡，文案对得上勾选项，并且照常落库
 *   ③ 造句失败（强制 reject）→ 仍然提交成功，气泡退回本地拼接的那句
 *   ④ 回归：一项都不勾提交 → 落库必须是 unsure（不能默认"按方案做了"）
 *
 * 组件内部节点 automator 选不到（0.12.1 的限制），所以走
 * `miniProgram.evaluate` + `page.selectComponent('#completeSheet')` 直接调组件方法，
 * 这是项目里对面板类组件的一贯做法（另一条腿是截图看渲染）。
 *
 * 用法：需要后端 + 开发者工具自动化端口(9420)。
 *   node verify-complete-sheet-chat.js
 */
const path = require('node:path')
const automator = require('miniprogram-automator')
const { getToken, api, openDb, createTempPlant, deletePlant, BASE } = require('./lib')

const SHOT_DIR = path.resolve(__dirname, 'shots-art')
const fs = require('node:fs')

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (!ok) failures++
  return ok
}
function checkTruthy(label, actual, extra) {
  const ok = Boolean(actual)
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | ' + (ok ? '命中' : '没命中') +
    (extra ? ' | ' + extra : ''))
  if (!ok) failures++
  return ok
}

/** 送进面板的候选（和服务的 speciesOptions 无关，直接用方案级候选） */
const PICKED_LABELS = ['花多多1号', '奥绿A2']

async function echoRequest(token, reminderId, items) {
  const startedAt = Date.now()
  const data = await api('/reminders/' + reminderId + '/echo', {
    method: 'POST',
    body: { items }
  }, token)
  return { text: String((data && data.text) || ''), ms: Date.now() - startedAt }
}

/** 在页面里选中完成面板组件（组件内部节点 automator 选不到） */
async function compCall(miniProgram, method, args) {
  return miniProgram.evaluate(function (methodName, methodArgs) {
    const pages = getCurrentPages()
    const page = pages[pages.length - 1]
    const comp = page && page.selectComponent('#completeSheet')
    if (!comp) return { __error: 'selectComponent(#completeSheet) 返回 null' }
    if (typeof comp[methodName] !== 'function') return { __error: '没有方法 ' + methodName }
    const result = comp[methodName].apply(comp, methodArgs || [])
    return { __ok: true, result: result === undefined ? null : result }
  }, method, args || [])
}

async function compData(miniProgram, key) {
  return miniProgram.evaluate(function (dataKey) {
    const pages = getCurrentPages()
    const page = pages[pages.length - 1]
    const comp = page && page.selectComponent('#completeSheet')
    return comp ? comp.data[dataKey] : null
  }, key)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function openSheet(miniProgram, plantId, reminder) {
  await miniProgram.reLaunch('/pages/garden/garden')
  await miniProgram.navigateTo('/pages/plant-detail/plant-detail?id=' + plantId)
  const page = await miniProgram.currentPage()
  await page.waitFor(2500)
  await page.setData({ sheetShow: false, sheetReminder: null })
  await page.waitFor(300)
  await page.setData({ sheetShow: true, sheetReminder: reminder })
  await page.waitFor(600)

  // 临时植物的默认提醒都排在 7 天后，会先命中「太早」档：
  // 面板先问"已经做了吗"。真实流程里用户也要先点这一下，脚本照走，
  // 否则后面调的 onToggle/onSubmit 是在"跳过太早判定"的假路径上跑。
  const stage = await compData(miniProgram, 'stage')
  if (stage === 'ask') {
    console.log('  （命中太早档，先点「已经做了」）')
    await compCall(miniProgram, 'onPickDone')
    await page.waitFor(400)
  }
  check('进入正常登记档（form）', await compData(miniProgram, 'stage'), 'form')
  return page
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const token = getToken()
  const plantId = await createTempPlant(token, '完成面板对话化验证', '月季')
  const db = openDb()
  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })

  try {
    const list = await api('/plants/' + plantId + '/reminders', {}, token)
    const fert = (list.reminders || []).find((item) => item.type === 'fertilizing')
    if (!fert) throw new Error('临时植物没有施肥提醒')

    // 让面板用方案级候选，正好两个，便于"勾两项"
    db.prepare('UPDATE plant_reminders SET options_json = ? WHERE id = ?')
      .run(JSON.stringify({ options: PICKED_LABELS, ask: '这次施的是哪一种？' }), fert.id)
    const detail = await api('/reminders/' + fert.id, {}, token)
    const reminder = detail.reminder

    console.log('=== ① 造句接口 ===')
    const samples = []
    for (let i = 0; i < 3; i++) {
      const one = await echoRequest(token, fert.id, PICKED_LABELS)
      samples.push(one)
      console.log('  ' + one.ms + ' ms｜' + one.text)
    }
    checkTruthy('返回了一句非空的话', samples[0].text.length > 0)
    check('不超过 30 字', samples.every((one) => one.text.replace(/\s/g, '').length <= 30), true)
    check('不含建议 / 评价词',
      samples.some((one) => /建议|记得|下次|别忘|注意/.test(one.text)), false)
    check('没有把勾选项原样丢回来（有加工）',
      samples.every((one) => one.text !== PICKED_LABELS.join('、')), true)

    console.log('')
    console.log('=== ② 勾 2 项提交：出现「我」的气泡 ===')
    await openSheet(miniProgram, plantId, reminder)

    const optionValues = await compData(miniProgram, 'options')
    console.log('  面板候选：' + JSON.stringify((optionValues || []).map((item) => item.label)))
    // 2026-09-21 放宽动态候选上限（2 → 4）后，这里不能再断言"总共 4 格"：
    // 这个品种的物种级候选可能被别的脚本写进同一个库，动态格会多于 2。
    // 真正要守住的是两件事：方案级候选排在最前、固定两格永远在最后。
    const labels = (optionValues || []).map((item) => item.label)
    checkTruthy('方案级的两个候选排在最前',
      labels[0] === PICKED_LABELS[0] && labels[1] === PICKED_LABELS[1],
      '实际=' + JSON.stringify(labels))
    check('最后两格固定是「用了别的」「说不清」',
      labels.slice(-2).join(' / '), '用了别的（补充里写） / 说不清')

    const dynamic = (optionValues || []).slice(0, 2).map((item) => item.value)
    for (const value of dynamic) {
      await compCall(miniProgram, 'onToggle', [{ currentTarget: { dataset: { value } } }])
    }
    const picked = await compData(miniProgram, 'picked')
    check('勾选状态进到了组件里', (picked || []).length, 2)

    await compCall(miniProgram, 'onSubmit')
    // 气泡要停留 1.2 秒，先拍一张"刚落下去"的
    await sleep(400)
    const instantText = await compData(miniProgram, 'echoText')
    const sending = await compData(miniProgram, 'sending')
    console.log('  气泡文案（刚发出）：' + instantText)
    console.log('  sending=' + sending)
    checkTruthy('提交后气泡立刻有文案（不等 AI）', String(instantText || '').length > 0,
      '文案=' + instantText)
    check('刚发出时用的是本地拼接（AI 还没回来不能开天窗）',
      instantText, PICKED_LABELS.join('、'))

    // 再等到 AI 的窗口结束前后，看它有没有把气泡换成更自然的那句
    await sleep(600)
    const finalText = await compData(miniProgram, 'echoText')
    console.log('  气泡文案（提交前）：' + finalText)
    checkTruthy('气泡文案和勾选项对得上（本地拼接或 AI 改写都行）',
      PICKED_LABELS.some((label) => String(finalText).includes(label)) ||
      String(finalText) === PICKED_LABELS.join('、') ||
      /肥|施/.test(String(finalText)), '文案=' + finalText)

    // 等面板关掉（页面拿到 submit 事件后才写库）
    let closed = false
    for (let i = 0; i < 20; i++) {
      await sleep(500)
      const show = await miniProgram.evaluate(function () {
        const pages = getCurrentPages()
        const page = pages[pages.length - 1]
        return page ? Boolean(page.data.sheetShow) : null
      })
      if (show === false) {
        closed = true
        break
      }
    }
    check('提交后面板关掉了', closed, true)

    const row = db.prepare('SELECT status, meta_json FROM plant_reminders WHERE id = ?').get(fert.id)
    const meta = JSON.parse(row.meta_json || '{}')
    const completion = meta.completion || {}
    console.log('  落库：status=' + row.status + ' done_items=' + JSON.stringify(completion.done_items))
    check('提醒已完成', row.status, 'completed')
    check('勾选的内容进了记录', (completion.done_items || []).length, 2)
    check('不会被记成"没登记"', Boolean(completion.unsure), false)

    console.log('')
    console.log('=== ③ 造句失败：仍然提交，气泡退回本地拼接 ===')
    const pest = (list.reminders || []).find((item) => item.type === 'pesticide')
    await openSheet(miniProgram, plantId, { ...pest, options: PICKED_LABELS, ask: '这次用的是哪一种？' })
    await compCall(miniProgram, 'onToggle', [{ currentTarget: { dataset: { value: 'pesticide_0' } } }])
    await compCall(miniProgram, 'onToggle', [{ currentTarget: { dataset: { value: 'pesticide_1' } } }])
    // 模拟"AI 没回来 / 报错"：直接把造句请求换成一个必然失败的 Promise
    await miniProgram.evaluate(function () {
      const pages = getCurrentPages()
      const comp = pages[pages.length - 1].selectComponent('#completeSheet')
      comp.requestEcho = function () {
        return Promise.reject(new Error('forced echo failure'))
      }
      return true
    })
    await compCall(miniProgram, 'onSubmit')
    await sleep(400)
    const fallbackText = await compData(miniProgram, 'echoText')
    console.log('  气泡文案：' + fallbackText)
    check('失败时气泡用本地拼接的那句', fallbackText, PICKED_LABELS.join('、'))

    for (let i = 0; i < 20; i++) {
      await sleep(500)
      const show = await miniProgram.evaluate(function () {
        const pages = getCurrentPages()
        return Boolean(pages[pages.length - 1].data.sheetShow)
      })
      if (show === false) break
    }
    const pestRow = db.prepare('SELECT status FROM plant_reminders WHERE id = ?').get(pest.id)
    check('造句失败也照常完成', pestRow.status, 'completed')

    console.log('')
    console.log('=== ④ 回归：一项都不勾 ===')
    const prune = (list.reminders || []).find((item) => item.type === 'pruning')
    await openSheet(miniProgram, plantId, prune)
    await compCall(miniProgram, 'onSubmit')
    await sleep(400)
    const unsureText = await compData(miniProgram, 'echoText')
    console.log('  气泡文案：' + unsureText)
    checkTruthy('一项不勾也会有回执文案', String(unsureText || '').length > 0, '文案=' + unsureText)

    for (let i = 0; i < 20; i++) {
      await sleep(500)
      const show = await miniProgram.evaluate(function () {
        const pages = getCurrentPages()
        return Boolean(pages[pages.length - 1].data.sheetShow)
      })
      if (show === false) break
    }
    const pruneRow = db.prepare('SELECT status, meta_json FROM plant_reminders WHERE id = ?').get(prune.id)
    const pruneCompletion = (JSON.parse(pruneRow.meta_json || '{}').completion) || {}
    check('未勾选 = 未登记（unsure）', Boolean(pruneCompletion.unsure), true)
    check('未登记时不写 done_items', (pruneCompletion.done_items || []).length, 0)

    console.log('')
    console.log('=== ⑤ 截图：气泡最终的样子 ===')
    // 真实流程里气泡只停 1.2 秒，而 screenshot 调用本身就要几百毫秒，
    // 按真实时序拍很容易拍空（试过一次，拍到的是面板已经关掉之后的页面）。
    // 所以这里只把「提交事件」挡掉让面板停在气泡状态 —— 跑的仍然是 onSubmit 的真实代码，
    // 换的只是提交时机，不是气泡内容。
    await openSheet(miniProgram, plantId, reminder)
    const demoValues = (await compData(miniProgram, 'options') || []).slice(0, 2)
    for (const item of demoValues) {
      await compCall(miniProgram, 'onToggle', [{ currentTarget: { dataset: { value: item.value } } }])
    }
    await miniProgram.evaluate(function () {
      const pages = getCurrentPages()
      const comp = pages[pages.length - 1].selectComponent('#completeSheet')
      comp.triggerEvent = function () {
        return null
      }
      return true
    })
    await compCall(miniProgram, 'onSubmit')
    await sleep(1800)
    const shotText = await compData(miniProgram, 'echoText')
    console.log('  截图时气泡里的文字：' + shotText)
    await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'complete-sheet-chat.png') })
    console.log('  截图：complete-sheet-chat.png')
  } finally {
    db.close()
    await deletePlant(token, plantId).catch(() => {})
    await miniProgram.close().catch(() => {})
  }

  console.log('')
  console.log(failures === 0 ? '全部通过' : failures + ' 项未通过')
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error('FAILED:', (err && err.stack) || err)
  process.exit(1)
})
