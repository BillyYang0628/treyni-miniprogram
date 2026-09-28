// 接口级验证：用药效果反馈 -> 第二轮 -> 两轮无效 -> AI 调整方案 -> 采用
// 全程使用临时植物，结束后自动删除，不影响正式开发数据
const { DatabaseSync } = require('node:sqlite')
const config = require('../../server/src/config')
const { createToken } = require('../../server/src/services/token')

const BASE = 'http://127.0.0.1:3000'
const token = createToken(1)

async function api(pathname, options = {}) {
  const response = await fetch(BASE + pathname, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(pathname + ' -> ' + response.status + ' ' + text.slice(0, 200))
  return data
}

function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  return ok
}

function seedTreatmentPair(db, plantId, userId, round, cycleId, disease) {
  const now = Date.now()
  const meta = JSON.stringify({ treatment_cycle_id: cycleId, treatment_round: round, disease })

  const treatment = db.prepare(`
    INSERT INTO plant_reminders (
      plant_id, user_id, type, title, content, summary_text, detail_content,
      due_at, interval_days, status, treatment_round, meta_json
    ) VALUES (?, ?, 'treatment', ?, ?, ?, ?, ?, NULL, 'completed', ?, ?)
  `).run(
    plantId, userId,
    `喷药处理：${disease}`,
    `第 ${round} 轮用药方案`,
    `处理${disease}：按方案喷药并注意安全`,
    `第 ${round} 轮用药方案：稀释后喷叶片背面，每7天一次。`,
    new Date(now - 5 * 24 * 3600 * 1000).toISOString(),
    round, meta
  )

  const feedback = db.prepare(`
    INSERT INTO plant_reminders (
      plant_id, user_id, type, title, content, summary_text, detail_content,
      due_at, interval_days, status, related_reminder_id, treatment_round, meta_json
    ) VALUES (?, ?, 'treatment_feedback', ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, ?)
  `).run(
    plantId, userId,
    `用药效果询问（第 ${round} 轮）`,
    `请确认第 ${round} 轮用药后，病虫害是否有明显改善。`,
    '反馈用药效果：看看病虫害有没有好转',
    `请确认第 ${round} 轮用药后，病虫害是否有明显改善。`,
    new Date(now).toISOString(),
    treatment.lastInsertRowid, round, meta
  )

  return Number(feedback.lastInsertRowid)
}

async function main() {
  const db = new DatabaseSync(config.dbPath)
  let failures = 0
  let plantId = null

  try {
    const created = await api('/plants', {
      method: 'POST',
      body: { name: '反馈流程测试', species: '月季', variety: '微型月季', notes: '临时测试植物' }
    })
    plantId = created.plant.id
    console.log('临时植物 id=' + plantId)

    const cycleId = 'test_cycle_' + Date.now()
    const feedback1 = seedTreatmentPair(db, plantId, 1, 1, cycleId, '黑斑病')

    // 第 1 轮：无效 -> 应生成第 2 轮
    const r1 = await api('/reminders/' + feedback1 + '/treatment-feedback', {
      method: 'POST',
      body: { effective: false }
    })
    console.log('第1轮反馈：next_treatment=' + (r1.next_treatment && r1.next_treatment.id) +
      '，next_feedback=' + (r1.next_feedback && r1.next_feedback.id))
    if (!check('无效后自动安排第二轮', Boolean(r1.next_treatment && r1.next_feedback), true)) failures++
    if (!check('第二轮提醒带详情', Boolean(r1.next_treatment.detail_content), true)) failures++

    // 第 2 轮：无效 -> 应要求 AI 判断
    const feedback2 = r1.next_feedback.id
    const r2 = await api('/reminders/' + feedback2 + '/treatment-feedback', {
      method: 'POST',
      body: { effective: false }
    })
    if (!check('两轮无效后要求 AI 判断', r2.need_ai_follow_up, true)) failures++
    if (!check('两轮无效后不再自动加轮次', r2.next_treatment, null)) failures++

    // AI 调整方案
    console.log('\n正在调用 AI 生成调整方案（约 1-3 分钟）...')
    const startedAt = Date.now()
    const consult = await api('/reminders/' + feedback2 + '/treatment-consult', { method: 'POST' })
    console.log('耗时 ' + Math.round((Date.now() - startedAt) / 1000) + ' 秒')
    console.log('---- 调整方案（节选）----\n' + consult.consult.suggestion.slice(0, 300))
    if (!check('AI 返回调整方案', consult.consult.suggestion.length > 300, true)) failures++
    if (!check('识别出病害', consult.consult.disease, '黑斑病')) failures++
    if (!check('识别出前两轮', consult.consult.previous_rounds, 2)) failures++

    // 采用方案
    const applied = await api('/reminders/' + feedback2 + '/treatment-consult/apply', {
      method: 'POST',
      body: { suggestion: consult.consult.suggestion }
    })
    console.log('采用后：喷药提醒=' + applied.next_treatment.title +
      '（' + applied.next_treatment.due_label + '），询问提醒=' + applied.next_feedback.title)
    if (!check('采用后创建新的喷药提醒', applied.next_treatment.type, 'treatment')) failures++
    if (!check('采用后创建配套询问提醒', applied.next_feedback.type, 'treatment_feedback')) failures++
    if (!check('新喷药提醒带完整方案', applied.next_treatment.detail_content.length > 300, true)) failures++

    // 有效分支
    const r3 = await api('/reminders/' + applied.next_feedback.id + '/treatment-feedback', {
      method: 'POST',
      body: { effective: true }
    })
    if (!check('选择有效后关闭本轮', r3.closed, true)) failures++

    const journals = await api('/plants/' + plantId + '/journal')
    console.log('养护历程条数：' + journals.journals.length)
    const feedbackJournals = journals.journals.filter((item) => item.type === 'treatment_feedback')
    console.log('反馈记录：' + feedbackJournals.map((item) => item.content).join(' / '))
    if (!check('反馈结果写入养护历程', feedbackJournals.length >= 3, true)) failures++
  } finally {
    if (plantId) {
      await api('/plants/' + plantId, { method: 'DELETE' }).catch((err) => console.log('清理失败：' + err.message))
      const left = db.prepare('SELECT COUNT(*) AS c FROM plant_reminders WHERE plant_id = ?').get(plantId).c
      const leftJournals = db.prepare('SELECT COUNT(*) AS c FROM plant_journal WHERE plant_id = ?').get(plantId).c
      console.log('清理临时植物：剩余提醒 ' + left + ' 条，剩余历程 ' + leftJournals + ' 条')
      if (!check('临时数据已随植物一起清理', left === 0 && leftJournals === 0, true)) failures++
    }
    db.close()
  }

  console.log(failures === 0 ? '\n全部检查通过' : '\n' + failures + ' 项检查未通过')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
