/**
 * 提醒推送：扫描快到期的提醒，通过微信订阅消息推给用户。
 * - 未配置模板 ID 时不发送，但会把“跳过原因”写进提醒的 meta_json，界面上能看到；
 * - 同一个提醒只推一次（meta_json.pushed_at）。
 */
const { getDb } = require('../db')
const subscribeMessage = require('./subscribeMessage')

const SCAN_INTERVAL_MS = 60 * 60 * 1000
const STARTUP_DELAY_MS = 30 * 1000
const AHEAD_HOURS = 24

let timer = null

function parseMeta(row) {
  try {
    return row.meta_json ? JSON.parse(row.meta_json) : {}
  } catch (e) {
    return {}
  }
}

function findCandidates(db, withinHours = AHEAD_HOURS) {
  const until = new Date(Date.now() + withinHours * 3600 * 1000).toISOString()
  return db
    .prepare(`
      SELECT r.*, p.name AS plant_name, p.species AS plant_species, u.openid AS openid
      FROM plant_reminders r
      INNER JOIN plants p ON p.id = r.plant_id
      INNER JOIN users u ON u.id = r.user_id
      WHERE r.status = 'pending'
        AND r.due_at <= ?
        AND p.status = 'active'
      ORDER BY r.due_at ASC
    `)
    .all(until)
    .filter((row) => !parseMeta(row).pushed_at)
}

function markPush(db, reminderId, patch) {
  const row = db.prepare('SELECT meta_json FROM plant_reminders WHERE id = ?').get(reminderId)
  const meta = parseMeta(row)
  Object.assign(meta, patch)
  db.prepare('UPDATE plant_reminders SET meta_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(meta), new Date().toISOString(), reminderId)
}

function waterStateOf(db, reminder) {
  let meta = {}
  try {
    meta = reminder.meta_json ? JSON.parse(reminder.meta_json) : {}
  } catch (e) {
    meta = {}
  }
  return meta.water || null
}

/**
 * 扫描一轮。dryRun=true 时只列候选项与文案，不真正发送。
 */
async function scan({ dryRun = false, withinHours = AHEAD_HOURS } = {}) {
  const db = getDb()
  const candidates = findCandidates(db, withinHours)
  const results = []

  for (const row of candidates) {
    const plant = { id: row.plant_id, name: row.plant_name, species: row.plant_species }
    const waterState = waterStateOf(db, row)
    const message = subscribeMessage.buildMessage(row, plant, waterState)

    if (dryRun) {
      results.push({ reminder_id: row.id, plant: row.plant_name, title: row.title, message, dryRun: true })
      continue
    }

    try {
      const outcome = await subscribeMessage.pushReminder({
        openid: row.openid,
        reminder: row,
        plant,
        waterState
      })

      if (outcome.skipped) {
        markPush(db, row.id, { push_status: 'skipped', push_error: outcome.reason })
        results.push({ reminder_id: row.id, skipped: true, reason: outcome.reason })
      } else {
        markPush(db, row.id, {
          pushed_at: new Date().toISOString(),
          push_status: 'sent',
          push_error: null
        })
        results.push({ reminder_id: row.id, sent: true })
      }
    } catch (err) {
      markPush(db, row.id, {
        push_status: 'failed',
        push_error: String(err.message).slice(0, 200),
        pushed_at: new Date().toISOString()
      })
      results.push({ reminder_id: row.id, failed: true, error: err.message })
    }
  }

  return { total: candidates.length, results }
}

function start() {
  if (timer) return

  setTimeout(() => {
    scan().catch((err) => console.warn('[reminderPush] 启动扫描失败：' + err.message))
  }, STARTUP_DELAY_MS)

  timer = setInterval(() => {
    scan().catch((err) => console.warn('[reminderPush] 定时扫描失败：' + err.message))
  }, SCAN_INTERVAL_MS)

  if (timer.unref) timer.unref()
}

function stop() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

module.exports = {
  AHEAD_HOURS,
  SCAN_INTERVAL_MS,
  findCandidates,
  scan,
  start,
  stop
}
