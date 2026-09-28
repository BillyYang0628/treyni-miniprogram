// 「+ 写记录」/「+ 计划」/ 聚合卡 的界面验证。
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { getToken, api, createTempPlant, deletePlant, openDb, BASE } = require('./lib')

const SHOT_DIR = path.resolve(__dirname, 'shots-art')

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (!ok) failures++
  return ok
}

function dayString(offset) {
  const d = new Date(Date.now() + offset * 86400000)
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const token = getToken()
  const plantId = await createTempPlant(token, '计划界面验证', '月季')
  const db = openDb()
  let miniProgram = null

  try {
    await new Promise((r) => setTimeout(r, 3000))

    // 造一条计划（四类以外），聚合卡应该收进去
    const planRes = await fetch(BASE + '/plants/' + plantId + '/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ kind: 'other', due_at: dayString(2), title: '买个补光灯' })
    })
    check('计划接口返回 201', planRes.status, 201)

    miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
    await miniProgram.reLaunch('/pages/garden/garden')
    await miniProgram.navigateTo('/pages/plant-detail/plant-detail?id=' + plantId)
    const page = await miniProgram.currentPage()
    await page.waitFor(5000)

    const data = await page.data()
    console.log('聚合卡条目：' + JSON.stringify(data.agenda))
    check('聚合卡有内容', (data.agenda || []).length > 0, true)
    check('四类外的计划进了聚合卡',
      (data.agenda || []).some((item) => item.planned && item.text.indexOf('补光灯') >= 0), true)
    await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'plan-agenda.png') })
    console.log('  截图：plan-agenda.png')

    // 「+ 写记录」：纯图文面板
    await page.callMethod('onWriteJournal')
    await page.waitFor(1200)
    check('打开写记录面板', (await page.data()).writeShow, true)
    await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'write-sheet.png') })
    await page.callMethod('onWriteCancel')
    await page.waitFor(600)

    // 「+ 计划」：计划面板
    await page.callMethod('onPlanSomething')
    await page.waitFor(1200)
    check('打开计划面板', (await page.data()).planShow, true)
    await miniProgram.screenshot({ path: path.join(SHOT_DIR, 'plan-sheet.png') })

    // 提交一个四类内的计划（换盆）→ 应该新建提醒并刷新
    await page.callMethod('onPlanDone')
    await page.waitFor(1000)
    check('面板关掉了', (await page.data()).planShow, false)

    // 写记录的落点
    await page.callMethod('onWriteSubmit', { detail: { content: '今天发现新芽', image_url: '' } })
    await page.waitFor(2500)
    const j = db
      .prepare("SELECT content, kind FROM plant_journal WHERE plant_id = ? AND content LIKE '%新芽%'")
      .get(plantId)
    check('写记录存下来了', Boolean(j), true)
    check('写记录是 done 不是 planned', j && j.kind, 'done')
    check('写记录没有碰提醒',
      db.prepare("SELECT COUNT(*) c FROM plant_reminders WHERE plant_id = ? AND status = 'pending'").get(plantId).c, 4)
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
