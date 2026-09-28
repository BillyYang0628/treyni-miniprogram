// 第四期：transplanted_at（含 PUT /plants 那个已存在的 bug）+ 换盆事件型 + 换盆确认。
const path = require('node:path')
const { getToken, api, createTempPlant, deletePlant, openDb, BASE } = require('./lib')
const rest = require(path.resolve(__dirname, '../../server/src/services/transplantRest.js'))

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (!ok) failures++
  return ok
}

function dayString(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000)
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

async function main() {
  const token = getToken()
  const plantId = await createTempPlant(token, '换盆验证', '月季')
  const db = openDb()
  const row = () => db.prepare('SELECT * FROM plants WHERE id = ?').get(plantId)

  try {
    console.log('=== 初始状态 ===')
    check('新植物没有 transplanted_at', row().transplanted_at || '', '')
    check('没有勾刚换盆时缓苗期不生效', rest.restInfo(row()).active, false)

    console.log('')
    console.log('=== 已存在的 bug：养很久之后才在编辑页勾"刚换盆" ===')
    // 把 created_at 改到 3 个月前，模拟"养了很久"
    db.prepare("UPDATE plants SET created_at = ?, is_recent_transplant = 0, transplanted_at = NULL WHERE id = ?")
      .run(new Date(Date.now() - 90 * 86400000).toISOString(), plantId)

    let info = rest.restInfo(row())
    check('勾之前：缓苗期不生效（因为开关是 0）', info.active, false)

    // 走真实的 PUT 接口，把开关从 0 改成 1
    await api('/plants/' + plantId, { method: 'PUT', body: { is_recent_transplant: 1 } }, token)
    const afterPut = row()
    check('PUT 之后写上了 transplanted_at', Boolean(afterPut.transplanted_at), true)
    info = rest.restInfo(afterPut)
    check('缓苗期生效了（这就是修复点）', info.active, true)
    check('缓苗期还剩 14 天', info.daysLeft, 14)

    // 再保存一次档案（开关还是 1），不应该把缓苗期重置
    const before = afterPut.transplanted_at
    await api('/plants/' + plantId, { method: 'PUT', body: { is_recent_transplant: 1, notes: '改个备注' } }, token)
    check('反复保存档案不会重置缓苗期', row().transplanted_at, before)

    console.log('')
    console.log('=== 换盆事件型提醒 ===')
    // 先把缓苗期清掉，方便看换盆的效果
    db.prepare('UPDATE plants SET is_recent_transplant = 0, transplanted_at = NULL WHERE id = ?').run(plantId)

    const created = await api('/plants/' + plantId + '/reminders', {
      method: 'POST',
      body: {
        type: 'repot',
        title: '换盆',
        content: '给月季换个大一点的盆',
        due_at: new Date().toISOString()
      }
    }, token)
    const repot = created.reminder
    check('建出了换盆提醒', repot.type, 'repot')
    check('换盆提醒没有周期（不会被排下一轮）', repot.interval_days, null)
    check('换盆不做太早判定', repot.timing.tolerance_days, null)

    const beforeCount = db
      .prepare('SELECT COUNT(*) c FROM plant_reminders WHERE plant_id = ?').get(plantId).c

    const res = await fetch(BASE + '/reminders/' + repot.id + '/repot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({
        pot_size: '3 加仑',
        pot_depth_mm: 250,
        pot_diameter_mm: 220,
        soil_type: '通用营养土',
        soil_id: 'mixed_unknown'
      })
    })
    const data = await res.json()
    check('换盆确认返回 200', res.status, 200)

    const p = row()
    check('花盆更新了', p.pot_size, '3 加仑')
    check('盆深更新了（喂水分模型的字段）', Number(p.pot_depth_mm), 250)
    check('土壤更新了', p.soil_id, 'mixed_unknown')
    check('换盆日写成今天', String(p.transplanted_at).slice(0, 10), dayString(0))
    check('自动标记为刚换盆', Number(p.is_recent_transplant), 1)
    check('缓苗期从今天起算、还剩 14 天', rest.restInfo(p).daysLeft, 14)

    check('换盆提醒被完成',
      db.prepare('SELECT status FROM plant_reminders WHERE id = ?').get(repot.id).status, 'completed')
    check('没有生成下一轮提醒',
      db.prepare('SELECT COUNT(*) c FROM plant_reminders WHERE plant_id = ?').get(plantId).c, beforeCount)
    check('写了养护历程',
      db.prepare("SELECT COUNT(*) c FROM plant_journal WHERE plant_id = ? AND type = 'repot'").get(plantId).c, 1)
    console.log('  养护历程：' + db.prepare("SELECT content FROM plant_journal WHERE plant_id = ? AND type = 'repot'").get(plantId).content)

    console.log('')
    console.log('=== 跳过档案更新 ===')
    const created2 = await api('/plants/' + plantId + '/reminders', {
      method: 'POST',
      body: { type: 'repot', title: '换盆', content: 'x', due_at: new Date().toISOString() }
    }, token)
    const res2 = await fetch(BASE + '/reminders/' + created2.reminder.id + '/repot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ skip_profile: true })
    })
    check('跳过时也返回 200', res2.status, 200)
    check('跳过时花盆没被动', row().pot_size, '3 加仑')
    check('跳过时仍然记了换盆日', String(row().transplanted_at).slice(0, 10), dayString(0))
    const j2 = db.prepare("SELECT content FROM plant_journal WHERE plant_id = ? ORDER BY id DESC LIMIT 1").get(plantId)
    console.log('  养护历程：' + j2.content)
    check('跳过时养护历程写明了没更新', j2.content.indexOf('没有更新') >= 0, true)

    console.log('')
    console.log('=== 不是换盆提醒时拒绝 ===')
    const list = await api('/plants/' + plantId + '/reminders', {}, token)
    const watering = list.reminders.find((r) => r.type === 'watering')
    const bad = await fetch(BASE + '/reminders/' + watering.id + '/repot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ pot_size: '5 加仑' })
    })
    check('对非换盆提醒调用被拒', bad.status, 400)
  } finally {
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
