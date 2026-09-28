// 验证完成登记面板（第一期）。
//
// 工具限制：miniprogram-automator 0.12.1 选不到自定义组件**内部**的节点
// （page.$('.cs-option') 永远是 0，组件自身的标签也选不到）。
// 所以这里分两条腿验证：
//   1) 渲染：截图，靠视觉确认面板、候选、安全提示都出来了；
//   2) 数据链路：直接调页面的提交处理器（callMethod），验证
//      「提醒被完成 + 养护历程记下具体做了什么 + meta.completion 落库」。
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { getToken, api, createTempPlant, deletePlant, openDb } = require('./lib')

const SHOT_DIR = path.resolve(__dirname, 'shots-art')

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (!ok) failures++
  return ok
}

function today() {
  const d = new Date()
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const token = getToken()
  const plantId = await createTempPlant(token, '完成面板验证', '月季')
  const db = openDb()
  let miniProgram = null

  try {
    let list = null
    for (let i = 0; i < 20; i++) {
      list = await api('/plants/' + plantId + '/reminders', {}, token)
      if ((list.reminders || []).length >= 4) break
      await new Promise((r) => setTimeout(r, 1000))
    }
    const pesticide = list.reminders.find((r) => r.type === 'pesticide')
    const fertilizing = list.reminders.find((r) => r.type === 'fertilizing')

    miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
    await miniProgram.reLaunch('/pages/garden/garden')
    await miniProgram.navigateTo('/pages/plant-detail/plant-detail?id=' + plantId)
    let page = await miniProgram.currentPage()
    await page.waitFor(5000)

    // ---- 1) 点列表的「完成」应弹面板，而不是直接完成 ----
    const buttons = await page.$$('.reminder-actions .mini-btn')
    let tapped = false
    for (const b of buttons) {
      if ((await b.text()).trim() === '完成') { await b.tap(); tapped = true; break }
    }
    check('列表上有「完成」按钮', tapped, true)
    await page.waitFor(1500)
    const opened = await page.data()
    check('点了之后面板打开', opened.sheetShow, true)
    // 列表按到期时间排序，第一个「完成」不一定是打药那条；
    // 以面板实际拿到的那条提醒为准，否则断言会打在别的提醒上（第一版就踩了这个）
    const targetId = opened.sheetReminder && opened.sheetReminder.id
    console.log('  面板对应的提醒：id=' + targetId + ' type=' + (opened.sheetReminder && opened.sheetReminder.type))
    check('面板拿到了提醒对象', Boolean(targetId), true)
    check('这时候提醒还没被完成（防误触）',
      (await api('/reminders/' + targetId, {}, token)).reminder.status, 'pending')
    await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'complete-sheet.png') })
    console.log('  截图：complete-sheet.png')

    // ---- 2) 提交（勾了一项） ----
    await page.callMethod('onSheetSubmit', {
      detail: { occurred_at: today(), done_items: ['按方案打的药'], unsure: false, note: '叶背也喷到了' }
    })
    await page.waitFor(3000)

    const after = await api('/reminders/' + targetId, {}, token)
    check('提交后提醒已完成', after.reminder.status, 'completed')
    check('面板关闭了', (await page.data()).sheetShow, false)

    const meta = after.reminder.meta && after.reminder.meta.completion
    console.log('  落库的 completion：' + JSON.stringify(meta))
    check('meta.completion 落库', Boolean(meta), true)
    check('记下了具体做了什么', meta && meta.done_items.length > 0, true)
    check('实际日期记下来了', Boolean(meta && meta.occurred_at), true)

    const journal = db
      .prepare('SELECT content FROM plant_journal WHERE plant_id = ? ORDER BY id DESC LIMIT 1')
      .get(plantId)
    console.log('  养护历程那条：' + (journal && journal.content))
    check('养护历程带上了具体内容',
      Boolean(journal && journal.content.indexOf('｜') > 0), true)

    // ---- 3) 提醒详情：同一个面板 + 跳过不选 → 记「未登记」 ----
    if (fertilizing) {
      await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + fertilizing.id)
      page = await miniProgram.currentPage()
      await page.waitFor(4000)

      const stack = await page.$$('.action-stack .btn')
      for (const b of stack) {
        if ((await b.text()).trim() === '完成这条提醒') { await b.tap(); break }
      }
      await page.waitFor(1500)
      check('提醒详情里弹的是同一个面板', (await page.data()).sheetShow, true)
      await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'complete-sheet-detail.png') })

      // 一题都不选直接提交
      await page.callMethod('onSheetSubmit', {
        detail: { occurred_at: today(), done_items: [], unsure: true, note: '' }
      })
      await page.waitFor(3500)

      const f2 = await api('/reminders/' + fertilizing.id, {}, token)
      const meta2 = f2.reminder.meta && f2.reminder.meta.completion
      console.log('  没选任何一项时的 completion：' + JSON.stringify(meta2))
      check('跳过也落库了', Boolean(meta2), true)
      check('跳过记成「未登记」，不是"按方案做了"', meta2 && meta2.unsure, true)
      check('跳过时 done_items 为空', meta2 && meta2.done_items.length, 0)

      const j2 = db
        .prepare('SELECT content FROM plant_journal WHERE plant_id = ? ORDER BY id DESC LIMIT 1')
        .get(plantId)
      console.log('  跳过时的养护历程：' + (j2 && j2.content))
      check('跳过时养护历程写"未登记"',
        Boolean(j2 && j2.content.indexOf('未登记') >= 0), true)
    }

    // ---- 4) 撤销条 + 撤销（第二期）----
    await miniProgram.navigateBack()
    await page.waitFor(2500)
    page = await miniProgram.currentPage()
    const pruning = list.reminders.find((r) => r.type === 'pruning')
    if (pruning) {
      await page.setData({ sheetShow: true, sheetReminder: pruning })
      await page.waitFor(800)
      await page.callMethod('onSheetSubmit', {
        detail: { occurred_at: today(), done_items: ['剪了枯枝病叶'], unsure: false, note: '' }
      })
      await page.waitFor(3000)

      check('完成后出现撤销条', (await page.data()).undoShow, true)
      await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'undo-bar.png') })
      console.log('  截图：undo-bar.png')

      await page.callMethod('onUndo')
      await page.waitFor(3000)
      check('撤销后撤销条收掉', (await page.data()).undoShow, false)
      const p2 = await api('/reminders/' + pruning.id, {}, token)
      check('撤销后提醒回到 pending', p2.reminder.status, 'pending')
      const left = db
        .prepare("SELECT COUNT(*) c FROM plant_journal WHERE plant_id = ? AND content LIKE '%修剪%'")
        .get(plantId).c
      check('撤销后那条养护历程也被删掉', left, 0)
    }
  } finally {
    if (miniProgram) await miniProgram.close().catch(() => {})
    db.close()
    await deletePlant(token, plantId).catch((err) => console.log('清理失败：' + err.message))
  }

  console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项未通过')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
