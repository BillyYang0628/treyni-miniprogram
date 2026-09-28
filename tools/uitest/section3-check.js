// 第 3 板块接口级验证
// 1) 苗情与日期：开场白正确显示苗情与天数，不再把“9.13”算成 9132 天
// 2) 修改逻辑：只是陈述现状时先给建议，不直接提出档案修改
const { getToken, api, check, openDb, deletePlant } = require('./lib')

async function createPlant(token, body) {
  const created = await api('/plants', { method: 'POST', body }, token)
  return created.plant
}

async function main() {
  const token = getToken()
  const db = openDb()
  let failures = 0
  let plantId = null

  try {
    // 1) 苗情与日期
    const plant = await createPlant(token, {
      name: '小花苗',
      species: '月季',
      planting_date: '9.13',
      growth_stage: '小苗',
      plant_source: '网购',
      is_recent_transplant: 1
    })
    plantId = plant.id

    console.log('档案回读：' + JSON.stringify({
      planting_date: plant.planting_date,
      growth_stage: plant.growth_stage,
      plant_source: plant.plant_source,
      is_recent_transplant: plant.is_recent_transplant
    }))
    if (!check('苗情阶段已保存', plant.growth_stage, '小苗')) failures++
    if (!check('来源已保存', plant.plant_source, '网购')) failures++
    if (!check('换盆标记已保存', plant.is_recent_transplant, 1)) failures++

    const session = await api('/chat/gardener/session/' + plantId, {}, token)
    console.log('\n开场白：' + session.session.greeting)

    if (!check('提到苗情阶段', session.session.greeting.includes('小苗'), true)) failures++
    if (!check('提到缓苗期', session.session.greeting.includes('缓苗'), true)) failures++
    if (!check('没有把 9.13 算成几千天', /9\d{3} 天/.test(session.session.greeting), false)) failures++
    if (!check('天数合理', /到今天 0 天|到今天 1 天/.test(session.session.greeting), true)) failures++

    // 2) 只陈述现状：先给建议，不提修改
    console.log('\n发送：我家月季光照每天只有 4 小时，怎么办？')
    const started = Date.now()
    const chat = await api('/chat/gardener', {
      method: 'POST',
      body: { plant_id: plantId, message: '我家月季光照每天只有 4 小时，怎么办？' }
    }, token)
    console.log('耗时 ' + Math.round((Date.now() - started) / 1000) + ' 秒')
    console.log('回复：' + chat.reply.slice(0, 240))
    console.log('提出的变更：' + JSON.stringify(chat.pending_changes))

    if (!check('有回复', chat.reply.length > 50, true)) failures++
    if (!check('不直接提出修改', chat.pending_changes.length, 0)) failures++
    if (!check('给出了替代建议', /补光|灯|耐阴|品种|浇水|施肥/.test(chat.reply), true)) failures++
  } finally {
    if (plantId) {
      await deletePlant(token, plantId).catch((err) => console.log('清理失败：' + err.message))
      const left = db.prepare('SELECT COUNT(*) AS c FROM plant_reminders WHERE plant_id = ?').get(plantId).c
      console.log('清理临时植物：剩余提醒 ' + left + ' 条')
      if (!check('临时数据已清理', left, 0)) failures++
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
