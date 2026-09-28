/**
 * 每日定时任务：重新按天气推演每盆植物的下次浇水日期。
 * 提醒是几天前生成的，那时的预报已经过期，所以每天要重算一次。
 */
const { getDb } = require('../db')
const waterPlan = require('./waterPlan')

const CHECK_INTERVAL_MS = 30 * 60 * 1000
const STARTUP_DELAY_MS = 20 * 1000
const RUN_HOUR = 6
const RUN_MINUTE = 30
const STATE_KEY = 'water_job_last_run'

let timer = null

function getState(key) {
  const row = getDb().prepare('SELECT value FROM app_state WHERE key = ?').get(key)
  return row ? row.value : ''
}

function setState(key, value) {
  getDb().prepare(`
    INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, String(value))
}

function todayString() {
  const now = new Date()
  const pad = (value) => (value < 10 ? '0' + value : '' + value)
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

async function runOnce(reason) {
  const db = getDb()
  const plants = db
    .prepare("SELECT * FROM plants WHERE status = 'active'")
    .all()

  let updated = 0
  let failed = 0

  for (const plant of plants) {
    const reminder = db
      .prepare(`
        SELECT * FROM plant_reminders
        WHERE plant_id = ? AND type = 'watering' AND status = 'pending'
        ORDER BY due_at ASC LIMIT 1
      `)
      .get(plant.id)

    if (!reminder) continue

    try {
      await waterPlan.applyToReminder(reminder.id)
      updated++
    } catch (err) {
      failed++
      console.warn('[waterScheduler] 植物 #' + plant.id + ' 重算失败：' + err.message)
    }
  }

  setState(STATE_KEY, todayString())
  console.log(`[waterScheduler] ${reason}：重算 ${updated} 盆植物的浇水提醒（失败 ${failed}）`)
  return { updated, failed }
}

function shouldRunNow() {
  const now = new Date()
  const minutes = now.getHours() * 60 + now.getMinutes()
  const target = RUN_HOUR * 60 + RUN_MINUTE
  return minutes >= target && getState(STATE_KEY) !== todayString()
}

async function check() {
  if (!shouldRunNow()) return
  try {
    await runOnce('每日重算')
  } catch (err) {
    console.warn('[waterScheduler] 执行失败：' + err.message)
  }
}

function start() {
  if (timer) return

  // 启动后先检查一次（服务重启后补跑当天没跑的任务）
  setTimeout(() => {
    check().catch((err) => console.warn('[waterScheduler] 启动检查失败：' + err.message))
  }, STARTUP_DELAY_MS)

  timer = setInterval(() => {
    check().catch((err) => console.warn('[waterScheduler] 定时检查失败：' + err.message))
  }, CHECK_INTERVAL_MS)

  if (timer.unref) timer.unref()
}

function stop() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

module.exports = {
  RUN_HOUR,
  RUN_MINUTE,
  start,
  stop,
  runOnce,
  shouldRunNow
}
