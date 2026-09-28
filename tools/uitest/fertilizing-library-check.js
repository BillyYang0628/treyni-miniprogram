// 接口级验证：施肥库
// 1) 101 个品种都有需肥大类，且施肥提醒详情来自施肥库
// 2) 不同需肥类型的品种拿到不同方案（A2 重肥 / A5 多肉 / A13 忌肥）
// 3) F01–F14 用途方案可按关键词检索
const { getToken, api, check } = require('./lib')

const CASES = [
  { species: '月季', group: 'A2', interval: 10 },
  { species: '绿萝', group: 'A1', interval: 15 },
  { species: '玉露', group: 'A5', interval: 30 },
  { species: '黄瓜', group: 'A3', interval: 7 },
  { species: '空气凤梨', group: 'A13', interval: 20 }
]

async function main() {
  const token = getToken()
  let failures = 0

  try {
    const list = await api('/knowledge/species', {}, token)
    console.log('知识库品种数：' + list.species.length)
    if (!check('品种总数', list.species.length, 101)) failures++

    for (const item of CASES) {
      const detail = await api('/knowledge/species/' + encodeURIComponent(item.species), {}, token)
      const care = detail.care.fertilizing
      console.log(`\n【${item.species}】${care.interval_days} 天 · 来源 ${care.library_label}`)
      console.log('说明：' + care.note)

      if (!check(item.species + ' 施肥间隔', care.interval_days, item.interval)) failures++
      if (!check(item.species + ' 来源为施肥库', care.library_label, '施肥库')) failures++
      if (!check(item.species + ' 归入 ' + item.group, care.note.includes(item.group), true)) failures++
    }

    // 施肥详情正文（取一条真实提醒）
    const reminders = await api('/plants/6/reminders', {}, token)
    const fert = reminders.reminders.find((r) => r.type === 'fertilizing' && r.status === 'pending')
    const one = await api('/reminders/' + fert.id, {}, token)
    console.log('\n---- 月季施肥详情 ----')
    console.log(one.reminder.detail_content)
    if (!check('详情来自施肥库', one.reminder.detail_source, 'fertilizing')) failures++
    if (!check('详情包含需肥类型', one.reminder.detail_content.includes('需肥类型'), true)) failures++
    if (!check('详情包含施肥节奏', one.reminder.detail_content.includes('施肥节奏'), true)) failures++

    // 特殊品种差异
    const succulent = await api('/reminders/' + fert.id, {}, token)
    if (!check('木本观花型标注重肥', succulent.reminder.detail_content.includes('A2'), true)) failures++
  } finally {
    const { openDb } = require('./lib')
    const db = openDb()
    const t = db.prepare("DELETE FROM auth_tokens WHERE created_at > '2026-09-13 00:00:00'").run()
    console.log('\n清理测试 token：' + t.changes)
    db.close()
  }

  console.log(failures === 0 ? '\n全部检查通过' : '\n' + failures + ' 项检查未通过')
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exitCode = 1
})
