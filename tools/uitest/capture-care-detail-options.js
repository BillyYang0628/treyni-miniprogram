/**
 * 块 3 的对比图素材：提醒详情页生成方案之后，完成面板里出现的候选。
 *
 * 场景（一次跑完，两条腿都用真实数据）：
 *   临时植物 → 施肥提醒 → 调 /reminders/:id/detail 生成完整方案
 *   → 打开完成面板，看「这次用了什么？」下面列的是什么
 *
 * 改动前：面板拿的是**物种级候选**（这个品种常见的肥）或兜底四选项，问句是固定那句。
 * 改动后：面板拿的是**这条方案自己产出的候选**（方案里真的出现过的名字），问句也换成这份方案的关键问题。
 *
 * 用法：node capture-care-detail-options.js before|after
 */
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { getToken, api, createTempPlant, deletePlant } = require('./lib')

const PHASE = process.argv[2] || 'before'
const SHOT_DIR = path.resolve(__dirname, 'shots-art')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function compCall(miniProgram, method, args) {
  return miniProgram.evaluate(function (methodName, methodArgs) {
    const pages = getCurrentPages()
    const page = pages[pages.length - 1]
    const comp = page && page.selectComponent('#completeSheet')
    if (!comp) return { __error: 'selectComponent 返回 null' }
    return { __ok: true, result: comp[methodName].apply(comp, methodArgs || []) === undefined ? null : null }
  }, method, args || [])
}

async function compData(miniProgram, key) {
  return miniProgram.evaluate(function (dataKey) {
    const pages = getCurrentPages()
    const comp = pages[pages.length - 1].selectComponent('#completeSheet')
    return comp ? comp.data[dataKey] : null
  }, key)
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const token = getToken()
  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  const plantId = await createTempPlant(token, '方案候选截图', '月季')

  try {
    let list = null
    for (let i = 0; i < 20; i++) {
      list = await api('/plants/' + plantId + '/reminders', {}, token)
      if ((list.reminders || []).some((r) => r.type === 'fertilizing')) break
      await sleep(1000)
    }
    const fert = (list.reminders || []).find((r) => r.type === 'fertilizing')
    if (!fert) throw new Error('临时植物没有施肥提醒')

    // 生成完整操作方案（这条链路就是块 3 要动的）
    const gen = await api('/reminders/' + fert.id + '/detail', { method: 'POST', body: { force: true } }, token)
    const reminder = gen.reminder || {}
    console.log('方案长度 ' + String(reminder.detail_content || '').length +
      '｜方案级候选 ' + JSON.stringify(reminder.options || []) +
      '｜实时问题 ' + JSON.stringify(reminder.ask || ''))

    await miniProgram.reLaunch('/pages/garden/garden')
    await miniProgram.navigateTo('/pages/plant-detail/plant-detail?id=' + plantId)
    const page = await miniProgram.currentPage()
    await page.waitFor(2500)
    await page.setData({ sheetShow: false, sheetReminder: null })
    await page.waitFor(300)
    await page.setData({ sheetShow: true, sheetReminder: reminder })
    await page.waitFor(600)

    // 面板如果先进了「太早」二选一，先点「已经做了」进到登记档
    const stage = await compData(miniProgram, 'stage')
    if (stage === 'ask') {
      await compCall(miniProgram, 'onPickDone')
      await page.waitFor(400)
    }

    const question = await compData(miniProgram, 'questionText')
    const options = (await compData(miniProgram, 'options')) || []
    console.log('面板问句：' + question)
    console.log('面板候选：' + JSON.stringify(options.map((o) => o.label)))

    const out = 'care-detail-' + PHASE + '.png'
    await miniProgram.screenshot({ path: path.join(SHOT_DIR, out) })
    console.log('截图：' + out)
  } finally {
    await deletePlant(token, plantId).catch(() => {})
    await miniProgram.close().catch(() => {})
  }
}

main().catch((err) => {
  console.error('FAILED: ' + ((err && err.message) || err))
  process.exit(1)
})
