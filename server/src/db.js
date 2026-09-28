const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const config = require('./config')
const { toStoredPath } = require('./services/imageUrl')

let db

function ensureDatabase() {
  if (!db) {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true })
    db = new DatabaseSync(config.dbPath)
    db.exec('PRAGMA foreign_keys = ON;')
    db.exec('PRAGMA journal_mode = WAL;')
    // 并发写（定时任务 + 用户请求）时自动排队等待，避免直接抛 SQLITE_BUSY
    db.exec('PRAGMA busy_timeout = 5000;')
    createTables()
  }
  return db
}

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      openid TEXT NOT NULL UNIQUE,
      unionid TEXT,
      nickname TEXT,
      avatar_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS plants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      species TEXT NOT NULL,
      variety TEXT,
      pot_size TEXT,
      soil_type TEXT,
      location TEXT,
      light_environment TEXT,
      planting_date TEXT,
      notes TEXT,
      image_url TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

      CREATE TABLE IF NOT EXISTS plant_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plant_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        content TEXT,
        image_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (plant_id) REFERENCES plants(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 按品种缓存的「常见用品候选」：同一个品种的候选药/肥是一样的，
    -- 添加植物时生成一次，之后所有该品种的植物共用（见 services/speciesOptions.js）
    CREATE TABLE IF NOT EXISTS species_care_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      species TEXT NOT NULL UNIQUE,
      options_json TEXT,
      ai_model TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS plant_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT,
      due_at TEXT NOT NULL,
      interval_days INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      completed_at TEXT,
      related_reminder_id INTEGER,
      treatment_round INTEGER,
      meta_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (plant_id) REFERENCES plants(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      summary TEXT,
      compact_history_json TEXT,
      greeting TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (plant_id) REFERENCES plants(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      plant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS plant_pending_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      change_type TEXT NOT NULL,
      proposed_fields_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (plant_id) REFERENCES plants(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_plants_user_id ON plants(user_id);
CREATE INDEX IF NOT EXISTS idx_journal_plant_id ON plant_journal(plant_id);
    CREATE INDEX IF NOT EXISTS idx_reminders_plant_due ON plant_reminders(plant_id, due_at);
    CREATE INDEX IF NOT EXISTS idx_reminders_user_due ON plant_reminders(user_id, due_at);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_plant_id ON chat_sessions(plant_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, id);
    CREATE INDEX IF NOT EXISTS idx_pending_changes_plant_id ON plant_pending_changes(plant_id);
    CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_id ON auth_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires_at ON auth_tokens(expires_at);

    CREATE TABLE IF NOT EXISTS app_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_locations (
      user_id INTEGER PRIMARY KEY,
      city TEXT NOT NULL,
      district TEXT,
      location_id TEXT,
      lat REAL,
      lon REAL,
      source TEXT NOT NULL DEFAULT 'manual',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS plant_water_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      happened_at TEXT NOT NULL,
      rain_mm REAL,
      weather_json TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (plant_id) REFERENCES plants(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_water_events_plant ON plant_water_events(plant_id, happened_at);

    CREATE TABLE IF NOT EXISTS report_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      report_type TEXT NOT NULL DEFAULT 'care_summary',
      params_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_info TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (plant_id) REFERENCES plants(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER,
      plant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      title TEXT,
      period_text TEXT,
      content_json TEXT,
      stats_json TEXT,
      file_url TEXT,
      file_name TEXT,
      generated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (plant_id) REFERENCES plants(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_report_requests_plant ON report_requests(plant_id, id);
    CREATE INDEX IF NOT EXISTS idx_reports_plant ON reports(plant_id, id);

    CREATE TABLE IF NOT EXISTS wx_subscriptions (
      user_id INTEGER NOT NULL,
      template_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'accepted',
      accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, template_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `)

  migratePlantReminders()
  migrateChatSessions()
  migrateReminderTexts()
  migrateImagePaths()
  migratePesticideReminders()
  migrateReminderIntervals()
  migrateKnowledgeV2()
  migratePesticideLibraryV1()
  migrateFertilizingLibraryV1()
  migrateReminderWordingV1()
  migratePlantProfileFields()
  migrateJournalKindFields()
}

function hasRunMigration(name) {
  return Boolean(db.prepare('SELECT name FROM app_migrations WHERE name = ?').get(name))
}

function markMigration(name) {
  db.prepare('INSERT OR REPLACE INTO app_migrations (name) VALUES (?)').run(name)
}

/**
 * 一次性为已有植物补上“打药”提醒（新逻辑里添加植物会自动生成四类提醒）。
 * 用迁移表记录，避免用户手动删掉后又被自动加回来。
 */
function migratePesticideReminders() {
  const name = 'pesticide-reminders-v1'
  if (hasRunMigration(name)) return

  const plants = db
    .prepare(`
      SELECT * FROM plants
      WHERE status = 'active'
        AND id NOT IN (SELECT DISTINCT plant_id FROM plant_reminders WHERE type = 'pesticide')
    `)
    .all()

  const { buildRuleFor } = require('./services/defaultReminders')
  const { buildReminderSummary } = require('./services/reminderText')

  for (const plant of plants) {
    const rule = buildRuleFor(plant, { type: 'pesticide', title: '打药', fallbackInterval: 15 })
    const dueAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

    db.prepare(`
      INSERT INTO plant_reminders (
        plant_id, user_id, type, title, content, summary_text, detail_content,
        ai_model, due_at, interval_days, status
      ) VALUES (?, ?, 'pesticide', '打药', ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      plant.id,
      plant.user_id,
      rule.detail || '选择晴天上午或傍晚全株喷药，重点喷叶片背面，打完后 2 小时内不要浇水。',
      buildReminderSummary({ type: 'pesticide', title: '打药' }, plant.name),
      rule.detail || null,
      rule.source || null,
      dueAt,
      rule.intervalDays
    )
  }

  markMigration(name)
  if (plants.length) {
    console.log(`[migrate] 已为 ${plants.length} 盆植物补上打药提醒`)
  }
}

/**
 * 一次性把已有提醒的间隔天数对齐到品种知识库，并补上缺失的详细说明。
 * 只处理自动生成的养护提醒，不改动到期时间，也不覆盖已经由 AI 生成的内容。
 */
function migrateReminderIntervals() {
  const name = 'knowledge-intervals-v1'
  if (hasRunMigration(name)) return

  const { getCareRule } = require('./services/knowledge')

  const rows = db
    .prepare(`
      SELECT plant_reminders.*, plants.species AS plant_species
      FROM plant_reminders
      INNER JOIN plants ON plants.id = plant_reminders.plant_id
      WHERE plant_reminders.status = 'pending'
        AND plant_reminders.type IN ('watering', 'fertilizing', 'pesticide', 'pruning')
    `)
    .all()

  const updateInterval = db.prepare('UPDATE plant_reminders SET interval_days = ? WHERE id = ?')
  const updateDetail = db.prepare(
    "UPDATE plant_reminders SET detail_content = ?, ai_model = 'knowledge' WHERE id = ?"
  )

  let updated = 0

  for (const row of rows) {
    const rule = getCareRule(row.plant_species, row.type)
    if (!rule) continue

    if (rule.interval_days && rule.interval_days !== row.interval_days) {
      updateInterval.run(rule.interval_days, row.id)
      updated++
    }

    if (!row.detail_content && rule.detail) {
      updateDetail.run(rule.detail, row.id)
    }
  }

  markMigration(name)
  console.log(`[migrate] 已把 ${rows.length} 条提醒的间隔对齐到品种知识库（更新 ${updated} 条）`)
}

/**
 * 知识库升级到 101 品种 × 三大库之后，
 * 把已有待办养护提醒的间隔和详情内容换成新知识库的版本。
 */
function migrateKnowledgeV2() {
  const name = 'knowledge-v2-reminders'
  if (hasRunMigration(name)) return

  const { getCareRule } = require('./services/knowledge')

  const rows = db
    .prepare(`
      SELECT plant_reminders.*, plants.species AS plant_species
      FROM plant_reminders
      INNER JOIN plants ON plants.id = plant_reminders.plant_id
      WHERE plant_reminders.status = 'pending'
        AND plant_reminders.type IN ('watering', 'fertilizing', 'pesticide', 'pruning')
    `)
    .all()

  const update = db.prepare(`
    UPDATE plant_reminders
    SET interval_days = ?, detail_content = ?, ai_model = ?, ai_generated_at = NULL
    WHERE id = ?
  `)

  let updated = 0

  for (const row of rows) {
    const rule = getCareRule(row.plant_species, row.type)
    if (!rule || !rule.detail) continue

    update.run(rule.interval_days || row.interval_days, rule.detail, rule.library, row.id)
    updated++
  }

  markMigration(name)
  console.log(`[migrate] 已把 ${updated} 条提醒的详情换成新知识库内容`)
}

/**
 * 病虫害用药库 v1 上线后，把已有的“打药”提醒详情换成新用药库的内容。
 */
function migratePesticideLibraryV1() {
  const name = 'pesticide-library-v2'
  if (hasRunMigration(name)) return

  const knowledge = require('./services/knowledge')

  const rows = db
    .prepare(`
      SELECT plant_reminders.id, plant_reminders.interval_days, plants.species AS plant_species
      FROM plant_reminders
      INNER JOIN plants ON plants.id = plant_reminders.plant_id
      WHERE plant_reminders.status = 'pending' AND plant_reminders.type = 'pesticide'
    `)
    .all()

  const update = db.prepare(`
    UPDATE plant_reminders
    SET interval_days = ?, detail_content = ?, ai_model = 'pesticide', ai_generated_at = NULL
    WHERE id = ?
  `)

  let updated = 0

  for (const row of rows) {
    const rule = knowledge.getCareRule(row.plant_species, 'pesticide')
    if (!rule || !rule.detail) continue

    update.run(rule.interval_days || row.interval_days, rule.detail, row.id)
    updated++
  }

  markMigration(name)
  console.log(`[migrate] 已把 ${updated} 条打药提醒换成新的病虫害用药库内容`)
}

/**
 * 施肥库 v1 上线后，把已有的“施肥”提醒详情换成新的施肥库内容。
 */
function migrateFertilizingLibraryV1() {
  const name = 'fertilizing-library-v1'
  if (hasRunMigration(name)) return

  const knowledge = require('./services/knowledge')

  const rows = db
    .prepare(`
      SELECT plant_reminders.id, plant_reminders.interval_days, plants.species AS plant_species
      FROM plant_reminders
      INNER JOIN plants ON plants.id = plant_reminders.plant_id
      WHERE plant_reminders.status = 'pending' AND plant_reminders.type = 'fertilizing'
    `)
    .all()

  const update = db.prepare(`
    UPDATE plant_reminders
    SET interval_days = ?, detail_content = ?, ai_model = 'fertilizing', ai_generated_at = NULL
    WHERE id = ?
  `)

  let updated = 0

  for (const row of rows) {
    const rule = knowledge.getCareRule(row.plant_species, 'fertilizing')
    if (!rule || !rule.detail) continue

    update.run(rule.interval_days || row.interval_days, rule.detail, row.id)
    updated++
  }

  markMigration(name)
  console.log(`[migrate] 已把 ${updated} 条施肥提醒换成新的施肥库内容`)
}

/**
 * 养护提醒措辞改进：给稀释倍数补上家庭可操作的换算后，
 * 刷新已有待办提醒的详情内容（用药提醒已由 AI 生成的保持不动）。
 */
function migrateReminderWordingV1() {
  const name = 'reminder-wording-v1'
  if (hasRunMigration(name)) return

  const knowledge = require('./services/knowledge')

  const rows = db
    .prepare(`
      SELECT plant_reminders.id, plant_reminders.type, plant_reminders.ai_model,
             plants.species AS plant_species
      FROM plant_reminders
      INNER JOIN plants ON plants.id = plant_reminders.plant_id
      WHERE plant_reminders.status = 'pending'
        AND plant_reminders.type IN ('watering', 'fertilizing', 'pesticide', 'pruning')
    `)
    .all()

  const update = db.prepare('UPDATE plant_reminders SET detail_content = ? WHERE id = ?')
  let updated = 0

  for (const row of rows) {
    // AI 已经按这盆植物调整过的内容不覆盖
    if (row.ai_model === 'ai') continue

    const rule = knowledge.getCareRule(row.plant_species, row.type)
    if (!rule || !rule.detail) continue

    update.run(rule.detail, row.id)
    updated++
  }

  markMigration(name)
  console.log(`[migrate] 已刷新 ${updated} 条提醒的措辞（补上稀释换算）`)
}

/** 植物档案补充苗情字段：株型阶段、来源、是否刚换盆移栽 */
function migratePlantProfileFields() {
  const columns = db.prepare('PRAGMA table_info(plants)').all()
  const existing = new Set(columns.map((column) => column.name))

  const additions = [
    ['growth_stage', 'TEXT'],
    ['plant_source', 'TEXT'],
    ['is_recent_transplant', 'INTEGER'],
    // 实际换盆/移栽那天。缓苗期以它为起算点，没有（老数据）才退回 created_at。
    // 加它的原因：以前只看 created_at，导致"养了几个月之后才换盆"的缓苗期会立刻失效。
    ['transplanted_at', 'TEXT'],
    // 天气系数模型需要的结构化条件
    ['soil_id', 'TEXT'],
    ['exposure', 'TEXT'],
    ['pot_depth_mm', 'INTEGER'],
    ['pot_diameter_mm', 'INTEGER']
  ]

  for (const [name, type] of additions) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE plants ADD COLUMN ${name} ${type}`)
    }
  }
}

/**
 * 提醒拆成“列表摘要 + 详情完整内容”两部分后，
 * 老数据需要补上摘要，已经由 AI 生成的用药指导要挪到详情字段里。
 */
function migrateReminderTexts() {
  const { buildReminderSummary } = require('./services/reminderText')

  db.exec(`
    UPDATE plant_reminders
    SET detail_content = content
    WHERE detail_content IS NULL
      AND type IN ('treatment', 'treatment_feedback')
      AND content IS NOT NULL
      AND content <> ''
  `)

  const rows = db
    .prepare(`
      SELECT plant_reminders.*, plants.name AS plant_name
      FROM plant_reminders
      LEFT JOIN plants ON plants.id = plant_reminders.plant_id
      WHERE plant_reminders.summary_text IS NULL OR plant_reminders.summary_text = ''
    `)
    .all()

  if (!rows.length) return

  const update = db.prepare('UPDATE plant_reminders SET summary_text = ? WHERE id = ?')
  for (const row of rows) {
    update.run(buildReminderSummary(row, row.plant_name), row.id)
  }
}

/**
 * 早期版本把上传图片的完整地址（含 localhost 或局域网 IP）直接写进了数据库，
 * 导致换一个访问入口就看不到图片。这里统一改写成不含域名的相对路径。
 */
/**
 * 养护历程要同时装"已经发生的"和"计划中的"，所以补两个字段：
 *   kind        done（已记录）/ planned（计划）
 *   occurred_at 这件事实际发生（或计划发生）的日期，YYYY-MM-DD
 * 老数据一律当成 done，occurred_at 留空（页面退回用 created_at 显示）。
 */
function migrateJournalKindFields() {
  const columns = db.prepare('PRAGMA table_info(plant_journal)').all()
  const existing = new Set(columns.map((column) => column.name))

  const additions = [
    ['kind', "TEXT NOT NULL DEFAULT 'done'"],
    ['occurred_at', 'TEXT'],
    ['meta_json', 'TEXT']
  ]

  for (const [name, type] of additions) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE plant_journal ADD COLUMN ${name} ${type}`)
    }
  }
}

function migrateImagePaths() {
  const targets = [
    ['plants', 'image_url'],
    ['plant_journal', 'image_url'],
    ['users', 'avatar_url']
  ]

  for (const [table, column] of targets) {
    const rows = db
      .prepare(`SELECT id, ${column} AS value FROM ${table} WHERE ${column} LIKE 'http%'`)
      .all()

    if (!rows.length) continue

    const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`)
    for (const row of rows) {
      const stored = toStoredPath(row.value)
      if (stored && stored !== row.value) {
        update.run(stored, row.id)
      }
    }
  }
}

function migratePlantReminders() {
  const columns = db.prepare('PRAGMA table_info(plant_reminders)').all()
  const existing = new Set(columns.map((column) => column.name))

  const migrations = [
    ['related_reminder_id', 'INTEGER'],
    ['treatment_round', 'INTEGER'],
    ['meta_json', 'TEXT'],
    ['summary_text', 'TEXT'],
    ['detail_content', 'TEXT'],
    ['ai_model', 'TEXT'],
    ['ai_generated_at', 'TEXT'],
    // AI 生成下一轮提醒的状态：pending / done / failed
    ['ai_status', 'TEXT'],
    ['ai_error', 'TEXT'],
    ['ai_reason', 'TEXT'],
    // 方案级候选项 + 这次要问用户的实时问题（第 5 期）
    ['options_json', 'TEXT']
  ]

  for (const [name, type] of migrations) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE plant_reminders ADD COLUMN ${name} ${type}`)
    }
  }
}

/** 老库补上会话开场白字段 */
function migrateChatSessions() {
  const columns = db.prepare('PRAGMA table_info(chat_sessions)').all()
  const existing = new Set(columns.map((column) => column.name))

  if (!existing.has('greeting')) {
    db.exec('ALTER TABLE chat_sessions ADD COLUMN greeting TEXT')
  }
}

module.exports = {
  ensureDatabase,
  getDb: ensureDatabase
}
