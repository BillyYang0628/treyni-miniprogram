// 接口级验证：病虫害用药库
// 1) 打药提醒详情来自用药库
// 2) 一个疗程无效后，复喷改用用药库的方案 B（不同作用机理）
const { getToken, api, check, openDb, seedTreatmentPair, createTempPlant, deletePlant } = require('./lib')

async function main() {
  const token = getToken()
  const db = openDb()
  let failures = 0
  const plants = []

  const cases = [
    { disease: '黑斑病', species: '月季', expect: '戊唑醇', source: '月季换用方案' },
    { disease: '白粉病', species: '月季', expect: '嘧菌酯', source: '月季换用方案' },
    { disease: '红蜘蛛', species: '月季', expect: '联苯肼酯', source: '月季换用方案' },
    { disease: '白粉病', species: '黄瓜', expect: '戊唑醇', source: '黄瓜换用方案' }
  ]

  try {
    for (const item of cases) {
      const plantId = await createTempPlant(token, '用药库测试', item.species)
      plants.push(plantId)

      const cycle = 'pest_lib_' + Date.now() + '_' + item.species + '_' + item.disease
      const pair = seedTreatmentPair(db, plantId, 1, 1, cycle, item.disease)

      const feedback = await api('/reminders/' + pair.feedbackId + '/treatment-feedback', {
        method: 'POST',
        body: { effective: false }
      }, token)

      const next = feedback.next_treatment
      console.log('\n【' + item.species + ' · ' + item.disease + '】复喷方案：')
      console.log(next.detail_content)
      if (!check(item.species + item.disease + ' 换用 ' + item.expect, next.detail_content.includes(item.expect), true)) failures++
      if (!check(item.species + item.disease + ' 标注不同作用机理', next.detail_content.includes('不同作用机理'), true)) failures++
      if (!check(item.species + item.disease + ' 详情来自用药库', next.detail_source, 'pesticide')) failures++
    }

    const safety = await api('/knowledge/species/月季', {}, token)
    console.log('\n月季知识库衔接：' + Object.entries(safety.care)
      .map(([k, v]) => k + '=' + v.interval_days).join('，'))
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
