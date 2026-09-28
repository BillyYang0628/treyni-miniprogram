// 第五期：结构化记录喂 AI + 物种级候选 + 方案级候选/实时问题。
const path = require('node:path')
const { getToken, api, createTempPlant, deletePlant, openDb, BASE } = require('./lib')
const nextReminder = require(path.resolve(__dirname, '../../server/src/services/nextReminder.js'))
const speciesOptions = require(path.resolve(__dirname, '../../server/src/services/speciesOptions.js'))
const reminderText = require(path.resolve(__dirname, '../../server/src/services/reminderText.js'))

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (!ok) failures++
  return ok
}
function checkTruthy(label, actual) {
  const ok = Boolean(actual)
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | ' + (ok ? '命中' : '没命中'))
  if (!ok) failures++
  return ok
}

function dayString(offset) {
  const d = new Date(Date.now() + offset * 86400000)
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

async function complete(token, id, body) {
  const res = await fetch(BASE + '/reminders/' + id + '/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body || {})
  })
  return { status: res.status, data: await res.json() }
}

async function main() {
  const token = getToken()
  const plantId = await createTempPlant(token, '结构化历史验证', '月季')
  const db = openDb()

  try {
    let list = null
    for (let i = 0; i < 20; i++) {
      list = await api('/plants/' + plantId + '/reminders', {}, token)
      if ((list.reminders || []).length >= 4) break
      await new Promise((r) => setTimeout(r, 1000))
    }
    const fert = list.reminders.find((r) => r.type === 'fertilizing')
    const pest = list.reminders.find((r) => r.type === 'pesticide')

    console.log('=== ① 结构化记录喂给下一轮 AI ===')
    // 没完成过之前，历史里不该有"实际用了"这种话
    let history = nextReminder.buildHistory(db, plantId).join('\n')
    check('没完成过时历史里没有"实际用了"', history.indexOf('实际用了') >= 0, false)

    // 完成一次施肥，勾上具体用了什么
    await complete(token, fert.id, {
      occurred_at: dayString(-2),
      done_items: ['花多多1号'],
      late_reason: 'weather',
      late_note: '这两天一直下雨'
    })
    history = nextReminder.buildHistory(db, plantId).join('\n')
    console.log('--- 送给 AI 的历史 ---')
    history.split('\n').forEach((line) => console.log('  ' + line))
    checkTruthy('历史里带上了具体用了什么', history.indexOf('花多多1号') >= 0)
    checkTruthy('历史里带上了迟做原因', history.indexOf('天气不合适') >= 0)
    checkTruthy('历史里带上了备注', history.indexOf('一直下雨') >= 0)

    // "说不清"要如实说"未登记"，不能默认按方案做了
    await complete(token, pest.id, { occurred_at: dayString(0), unsure: true })
    history = nextReminder.buildHistory(db, plantId).join('\n')
    checkTruthy('说不清时历史写「实际做了什么未登记」', history.indexOf('实际做了什么未登记') >= 0)
    check('未登记时不会假装用户按方案做了', history.indexOf('按方案') >= 0, false)

    console.log('')
    console.log('=== ② 物种级候选（按品种缓存）===')
    const species = '不存在的品种-' + Date.now()
    check('没生成过时没有缓存', speciesOptions.optionsFor(species, 'fertilizing').length, 0)

    speciesOptions.save(species, {
      fertilizing: ['花多多1号', '奥绿A2', '螯合铁', '骨粉', '第五个应该被截掉'],
      pesticide: ['苯醚甲环唑3000倍液'],
      pruning: []
    })
    const cached = speciesOptions.optionsFor(species, 'fertilizing')
    console.log('  读回来的候选：' + JSON.stringify(cached))
    check('缓存读得回来', cached[0], '花多多1号')
    check('每类最多 4 个', cached.length, 4)
    check('浇水不取物种级候选（那是"浇到什么程度"的问题）',
      speciesOptions.optionsFor(species, 'watering').length, 0)

    // 缓存命中时 ensure 不应该再调 AI
    const again = await speciesOptions.ensure(species)
    check('命中缓存时不重复生成', again && again.pesticide[0], '苯醚甲环唑3000倍液')

    console.log('')
    console.log('=== ③ 方案级候选 + 实时问题 ===')
    // 直接写 options_json 模拟"生成方案时 AI 产出的候选"
    db.prepare('UPDATE plant_reminders SET options_json = ? WHERE id = ?')
      .run(JSON.stringify({ options: ['换了别的牌子的肥', '按说明稀释'], ask: '这次是按说明配的浓度吗？' }), fert.id)
    const detail = await api('/reminders/' + fert.id, {}, token)
    console.log('  提醒上的 options：' + JSON.stringify(detail.reminder.options))
    console.log('  提醒上的 ask：' + detail.reminder.ask)
    check('方案级候选透出来了', detail.reminder.options.length, 2)
    check('实时问题透出来了', detail.reminder.ask, '这次是按说明配的浓度吗？')

    // 脏数据不能把接口带崩
    db.prepare('UPDATE plant_reminders SET options_json = ? WHERE id = ?').run('{坏掉的 json', fert.id)
    const broken = await api('/reminders/' + fert.id, {}, token)
    check('options_json 坏掉时降级成空数组', Array.isArray(broken.reminder.options), true)
    check('坏掉时 ask 是空串', broken.reminder.ask, '')

    console.log('')
    console.log('=== ④ 物种级候选会跟着提醒一起下发 ===')
    speciesOptions.save('月季', { fertilizing: ['花多多1号'], pesticide: ['苯甲·吡唑酯'], pruning: [] })
    const list2 = await api('/plants/' + plantId + '/reminders', {}, token)
    const fert2 = list2.reminders.find((r) => r.type === 'fertilizing')
    const pest2 = list2.reminders.find((r) => r.type === 'pesticide')
    console.log('  施肥提醒的 care_options：' + JSON.stringify(fert2.care_options))
    console.log('  打药提醒的 care_options：' + JSON.stringify(pest2.care_options))
    check('施肥带上了物种级候选', fert2.care_options[0], '花多多1号')
    check('打药带上了自己的那一类', pest2.care_options[0], '苯甲·吡唑酯')
    check('浇水那类不带物种级候选',
      (list2.reminders.find((r) => r.type === 'watering').care_options || []).length, 0)

    console.log('')
    console.log('=== ⑤ 完成登记压缩成一行（describeCompletion）===')
    const row = db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(fert.id)
    const line = reminderText.describeCompletion(row)
    console.log('  ' + line)
    // 注意：describeCompletion 读的是「完成登记」(meta.completion)，
    // 不是 options_json（那是候选清单）。这两者别搞混——第一版测试就写错了。
    checkTruthy('压缩出来带"实际用了什么"', line.indexOf('花多多1号') >= 0)
    checkTruthy('压缩出来带迟做原因', line.indexOf('天气不合适') >= 0)
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
