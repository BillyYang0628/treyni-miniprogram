// 测试公共方法：调用后端接口、断言、造临时用药提醒数据
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const config = require('../../server/src/config')
const { createToken } = require('../../server/src/services/token')

const BASE = 'http://127.0.0.1:3000'

function getToken() {
  return createToken(1)
}

async function api(pathname, options = {}, token) {
  const response = await fetch(BASE + pathname, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  })
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch (e) {
    data = text
  }
  if (!response.ok) throw new Error(pathname + ' -> ' + response.status + ' ' + text.slice(0, 200))
  return data
}

function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  return ok
}

function openDb() {
  const db = new DatabaseSync(config.dbPath)
  // 与服务端共用同一个库：写冲突时等待而不是直接报错
  db.exec('PRAGMA busy_timeout = 5000;')
  return db
}

/** 造一个已完成的喷药提醒 + 待反馈的效果询问提醒 */
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
    `第 ${round} 轮用药方案：用苯醚甲环唑3000倍液喷叶片背面，每7天一次，共3次。`,
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

  return {
    treatmentId: Number(treatment.lastInsertRowid),
    feedbackId: Number(feedback.lastInsertRowid)
  }
}

async function createTempPlant(token, name, species) {
  const created = await api('/plants', {
    method: 'POST',
    body: {
      name: name || '反馈流程测试',
      species: species || '月季',
      variety: species ? '' : '微型月季',
      notes: '临时测试植物'
    }
  }, token)
  return created.plant.id
}

async function deletePlant(token, plantId) {
  await api('/plants/' + plantId, { method: 'DELETE' }, token)
}

/**
 * 取命令行参数，写成 --plant=6 / --reminder=86 这种。
 * 老走查脚本原来把植物 id / 提醒 id 写死在文件里（PLANT_ID = 6），
 * 库里清过一次数据之后这些脚本全部失效。现在一律走「命令行指定 → 自动挑 → 现造」。
 */
function argValue(key) {
  const prefix = '--' + key + '='
  const found = process.argv.find((item) => item.indexOf(prefix) === 0)
  return found ? found.slice(prefix.length) : ''
}

/**
 * 挑一盆"有东西可看"的植物（详情页 / 截图类脚本用）。
 * 顺序：--plant=<id> → 库里详情报文和日记最多的那盆 → 现造一盆临时植物（返回值里标 temp）。
 *
 * @returns {Promise<{id: number, temp: boolean}>}
 */
async function resolvePlantId(token, options = {}) {
  const explicit = Number(argValue('plant'))
  if (explicit) return { id: explicit, temp: false }

  const db = options.db || openDb()
  try {
    const row = db.prepare(`
      SELECT p.id,
        (SELECT COUNT(*) FROM plant_reminders r
          WHERE r.plant_id = p.id AND length(coalesce(r.detail_content, '')) > 200) AS details,
        (SELECT COUNT(*) FROM plant_journal j WHERE j.plant_id = p.id) AS journals
      FROM plants p
      ORDER BY details DESC, journals DESC, p.id ASC
      LIMIT 1
    `).get()
    if (row && row.details > 0) return { id: row.id, temp: false }
  } finally {
    if (!options.db) db.close()
  }

  const id = await createTempPlant(token, options.name || '走查临时植物', options.species || '月季')
  return { id, temp: true }
}

/** 按条件找一条提醒 id（--reminder=<id> 优先） */
function findReminderId(db, options = {}) {
  const explicit = Number(argValue('reminder'))
  if (explicit) return explicit

  const clauses = []
  const args = []
  if (options.plantId) { clauses.push('plant_id = ?'); args.push(options.plantId) }
  if (options.type) { clauses.push('type = ?'); args.push(options.type) }
  if (Array.isArray(options.types) && options.types.length) {
    clauses.push('type IN (' + options.types.map(() => '?').join(', ') + ')')
    args.push(...options.types)
  }
  if (options.status) { clauses.push('status = ?'); args.push(options.status) }
  if (options.minDetailLength) {
    clauses.push("length(coalesce(detail_content, '')) >= ?")
    args.push(options.minDetailLength)
  }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''
  const row = db
    .prepare('SELECT id FROM plant_reminders' + where + ' ORDER BY id DESC LIMIT 1')
    .get(...args)
  return row ? row.id : null
}

/** 找一条养护日记 id（--journal=<id> 优先） */
function findJournalId(db, plantId) {
  const explicit = Number(argValue('journal'))
  if (explicit) return explicit
  const row = plantId
    ? db.prepare('SELECT id FROM plant_journal WHERE plant_id = ? ORDER BY id DESC LIMIT 1').get(plantId)
    : db.prepare('SELECT id FROM plant_journal ORDER BY id DESC LIMIT 1').get()
  return row ? row.id : null
}

/** 诊断脚本要一张真实图片：找出 uploads/diagnosis 下最新的一张（用相对路径，接口要的格式） */
function latestDiagnosisImage() {
  const dir = path.resolve(__dirname, '../../server/data/uploads/diagnosis')
  if (!fs.existsSync(dir)) return ''
  const files = fs.readdirSync(dir).filter((name) => /\.(jpe?g|png)$/i.test(name))
  if (!files.length) return ''
  files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs)
  return 'diagnosis/' + files[0]
}

module.exports = {
  BASE,
  getToken,
  api,
  check,
  openDb,
  seedTreatmentPair,
  createTempPlant,
  deletePlant,
  argValue,
  resolvePlantId,
  findReminderId,
  findJournalId,
  latestDiagnosisImage
}
