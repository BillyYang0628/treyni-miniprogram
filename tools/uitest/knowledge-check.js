// 接口级验证：知识库驱动的提醒生成
// 1) 新植物自动生成四类提醒，间隔取知识库，首轮时间为 浇水+1 / 施肥+7 / 打药+7 / 修剪+30
// 2) 知识库没有的品种走兜底间隔，详细内容留给 AI 生成
const { getToken, api, check, openDb, deletePlant } = require('./lib')

async function createPlant(token, name, species) {
  const created = await api('/plants', {
    method: 'POST',
    body: { name, species, variety: '', notes: '知识库测试植物' }
  }, token)
  return created.plant.id
}

async function reminderMap(token, plantId) {
  const data = await api('/plants/' + plantId + '/reminders', {}, token)
  const map = {}
  for (const item of data.reminders) {
    if (item.status === 'pending') map[item.type] = item
  }
  return map
}

async function main() {
  const token = getToken()
  const db = openDb()
  let failures = 0
  const plants = []

  try {
    // 月季：知识库间隔 浇水2 / 施肥10 / 打药15 / 修剪40
    const roseId = await createPlant(token, '知识库月季', '微型月季')
    plants.push(roseId)
    const rose = await reminderMap(token, roseId)

    console.log('月季提醒：' + Object.keys(rose).join(' / '))
    if (!check('自动生成四类提醒', Object.keys(rose).sort().join(','), 'fertilizing,pesticide,pruning,watering')) failures++

    if (!check('浇水间隔取知识库', rose.watering.interval_days, 2)) failures++
    if (!check('施肥间隔取知识库', rose.fertilizing.interval_days, 10)) failures++
    if (!check('打药间隔取知识库', rose.pesticide.interval_days, 15)) failures++
    if (!check('修剪间隔取知识库', rose.pruning.interval_days, 40)) failures++

    if (!check('浇水首轮 +1 天', rose.watering.due_label, '明天')) failures++
    if (!check('施肥首轮 +7 天', rose.fertilizing.due_label, '7天后')) failures++
    if (!check('打药首轮 +7 天', rose.pesticide.due_label, '7天后')) failures++
    console.log('修剪首次到期：' + rose.pruning.due_label + ' ' + rose.pruning.due_text)

    if (!check('打药摘要正确', rose.pesticide.summary_text, '给知识库月季打药：全株喷药，重点喷叶片背面')) failures++
    if (!check('打药带知识库详细内容', rose.pesticide.detail_source, 'knowledge')) failures++

    const detail = await api('/reminders/' + rose.pesticide.id, {}, token)
    console.log('打药详情开头：' + (detail.reminder.detail_content || '').slice(0, 60))
    if (!check('知识库详情已填充', detail.reminder.detail_content.length > 200, true)) failures++

    // 知识库没有的品种：走兜底
    const otherId = await createPlant(token, '知识库未知', '火星植物')
    plants.push(otherId)
    const other = await reminderMap(token, otherId)
    if (!check('未知品种兜底浇水间隔', other.watering.interval_days, 3)) failures++
    if (!check('未知品种兜底打药间隔', other.pesticide.interval_days, 15)) failures++
    if (!check('未知品种详情留给 AI', other.pesticide.has_detail, false)) failures++
  } finally {
    for (const id of plants) {
      await deletePlant(token, id).catch((err) => console.log('清理失败：' + err.message))
      const left = db.prepare('SELECT COUNT(*) AS c FROM plant_reminders WHERE plant_id = ?').get(id).c
      if (!check('临时植物 ' + id + ' 数据已清理', left, 0)) failures++
    }
    db.close()
  }

  console.log(failures === 0 ? '\n全部检查通过' : '\n' + failures + ' 项检查未通过')
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exitCode = 1
})
