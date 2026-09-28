const { buildReminderSummary } = require('./reminderText')
const { getCareRule } = require('./knowledge')
const { REST_DAYS, restInfo, localDateString } = require('./transplantRest')
const reminderTiming = require('./reminderTiming')

/**
 * 添加植物后自动生成的养护提醒。
 * firstDueDays 是首轮提醒的间隔：浇水 +1 天、施肥 +7 天、打药 +7 天、修剪 +30 天。
 * 之后的间隔天数优先取品种知识库，知识库里没有的品种再用兜底值。
 */
const CARE_RULES = [
  { type: 'watering', title: '浇水', firstDueDays: 1, fallbackInterval: 3 },
  { type: 'fertilizing', title: '施肥', firstDueDays: 7, fallbackInterval: 14 },
  { type: 'pesticide', title: '打药', firstDueDays: 7, fallbackInterval: 15 },
  { type: 'pruning', title: '修剪', firstDueDays: 30, fallbackInterval: 30 }
]

// 刚换盆 / 刚移栽的缓苗期：这期间一律不施肥（施肥库 F01 定植换盆：刚换盆 2–4 周不施）
// 天数与起算点统一在 services/transplantRest.js 里维护
const TRANSPLANT_REST_DAYS = REST_DAYS

const TRANSPLANT_REST_NOTE =
  '这盆刚换过盆或刚移栽，正在缓苗期，先不要施肥：' +
  '这时候根系还没恢复，施肥容易烧根，越施越糟。' +
  '放在散光通风的地方缓一缓，等这段缓苗期过去、看到新叶新芽再按下面的方案施肥。'

const FALLBACK_CONTENT = {
  watering: '1. 观察盆土表面是否发白，或手指插入土中约 2-3 厘米检查干湿。\n2. 确认盆土偏干后再浇水，浇到盆底有水流出即可。\n3. 倒掉托盘积水，避免长期浸泡导致烂根。',
  fertilizing: '1. 选择适合当前植物的稀薄液肥。\n2. 避开高温暴晒和刚换盆阶段。\n3. 沿盆边少量浇施，避免直接接触茎干和叶片。',
  pesticide: '1. 选择晴天的上午或傍晚，避开高温和雨天。\n2. 全株喷洒，重点喷叶片背面和盆土表面。\n3. 戴好口罩和手套，打完药洗手，2 小时内不要浇水。',
  pruning: '1. 使用干净、锋利的剪刀，用前先消毒。\n2. 剪掉枯叶、病叶和交叉过密枝条。\n3. 修剪后清理盆面残叶，保持通风。'
}

function buildRuleFor(plant, care) {
  const knowledge = getCareRule(plant && plant.species, care.type)
  const intervalDays = (knowledge && knowledge.interval_days) || care.fallbackInterval

  return {
    type: care.type,
    title: care.title,
    intervalDays,
    // 知识库里有详细说明就先用知识库内容，用户仍可在详情页让 AI 重新生成
    detail: knowledge && knowledge.detail ? knowledge.detail : '',
    note: knowledge && knowledge.note ? knowledge.note : '',
    // 记录内容来自哪一个库（daily_care / fertilizing / pesticide），详情页据此显示来源
    source: knowledge && knowledge.detail ? knowledge.library : '',
    speciesId: knowledge ? knowledge.speciesId : ''
  }
}

function createDefaultRemindersForPlant(db, plant) {
  const now = Date.now()
  const plantName = plant.name || ''
  const transplantRest = Number(plant.is_recent_transplant) ? 1 : 0

  for (const care of CARE_RULES) {
    const rule = buildRuleFor(plant, care)

    // 缓苗期：施肥提醒顺延到缓苗结束，并在正文里说明为什么先不施肥
    const restApplied = Boolean(transplantRest) && rule.type === 'fertilizing'
    const firstDueDays = restApplied ? TRANSPLANT_REST_DAYS : care.firstDueDays
    const dueAt = new Date(now + firstDueDays * 24 * 60 * 60 * 1000).toISOString()
    const baseContent = rule.detail || FALLBACK_CONTENT[rule.type]
    const content = restApplied ? TRANSPLANT_REST_NOTE + '\n\n' + baseContent : baseContent
    const restDue = restApplied ? restInfo(plant).until : null

    const summary = restApplied
      ? `${plantName}还在缓苗期，先不施肥（${restDue.getMonth() + 1} 月 ${restDue.getDate()} 日后再看）`
      : buildReminderSummary({ type: rule.type, title: rule.title }, plantName)

    const meta = restApplied
      ? JSON.stringify({
        rest: 'transplant',
        rest_days: TRANSPLANT_REST_DAYS,
        rest_until: localDateString(restDue)
      })
      : null

    const inserted = db.prepare(`
      INSERT INTO plant_reminders (
        plant_id, user_id, type, title, content, summary_text, detail_content,
        ai_model, due_at, interval_days, status, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      plant.id,
      plant.user_id,
      rule.type,
      rule.title,
      content,
      summary,
      // 缓苗期的提醒要把“先不施肥”的说明一并放进详情正文
      restApplied ? content : (rule.detail || null),
      rule.source || null,
      dueAt,
      rule.intervalDays,
      meta
    )

    // 阈值在提醒生成的那一刻冻结下来，点完成时只读不算
    reminderTiming.freezeTiming(db, inserted.lastInsertRowid)
  }
}

/**
 * 生成下一轮提醒。
 *
 * options.occurredAt（YYYY-MM-DD）：用户实际做这件事的日期。
 * 下一轮从**实际完成日**起算，而不是从"点完成那一刻"起算——
 * 用户今天补录三天前浇的水，那下次浇水就该按三天前算（2026-09-18 定稿）。
 *
 * 唯一护栏：算出来的日期不能落在过去（补录太久远时会触发），
 * 那就退回"今天 + 间隔"。
 */
function createNextReminder(db, reminder, options = {}) {
  const intervalDays = Number(reminder.interval_days) || 7

  const dayMs = 24 * 60 * 60 * 1000
  const base = options.occurredAt
    ? new Date(String(options.occurredAt) + 'T09:00:00+08:00')
    : new Date()
  let dueAt = new Date(base.getTime() + intervalDays * dayMs)

  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (isNaN(dueAt.getTime()) || dueAt < todayStart) {
    // 落点和正常路径保持一致：当天 09:00（而不是 00:00，否则详情页会显示"0 点"）
    dueAt = new Date(todayStart.getTime() + intervalDays * dayMs + 9 * 3600 * 1000)
  }

  const plant = db.prepare('SELECT name, species FROM plants WHERE id = ?').get(reminder.plant_id)
  const summary = buildReminderSummary(reminder, plant ? plant.name : '')

  // 下一轮同样优先使用知识库内容，没有的（例如手动提醒、用药提醒）留空由 AI 或用户补充
  const care = CARE_RULES.find((item) => item.type === reminder.type)
  const rule = care && plant ? buildRuleFor(plant, care) : null
  const content = rule && rule.detail ? rule.detail : reminder.content

  const result = db.prepare(`
    INSERT INTO plant_reminders (
      plant_id, user_id, type, title, content, summary_text, detail_content,
      ai_model, due_at, interval_days, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    reminder.plant_id,
    reminder.user_id,
    reminder.type,
    reminder.title,
    content,
    summary,
    rule && rule.detail ? rule.detail : null,
    rule && rule.source ? rule.source : null,
    dueAt.toISOString(),
    intervalDays
  )

  reminderTiming.freezeTiming(db, result.lastInsertRowid)

  return db.prepare('SELECT * FROM plant_reminders WHERE id = ?').get(result.lastInsertRowid)
}

module.exports = {
  CARE_RULES,
  createDefaultRemindersForPlant,
  createNextReminder,
  buildRuleFor
}
