/**
 * 「这盆植物最近发生了什么」—— 养护日记 + 已完成的提醒（含用户当时勾的"实际做了什么"）。
 *
 * 为什么单独抽一个服务（2026-09-21，第六批块 4）：
 * 这段数据原来只有 `nextReminder.buildHistory()` 在用（给"排下一轮提醒"当参考）。
 * AI 花农对话完全看不到它，于是出现这种场面：
 *   用户在完成面板勾了「花多多1号」→ 转头问「我上次施肥用的是什么？」
 *   → 托蕾妮回答"档案里只记了提醒，没记上次用了什么肥，我查不到"。
 * 记了却查不到，比没记更让人困惑。
 *
 * 两个消费方（下一轮提醒 / AI 对话）必须用同一份口径，否则会出现
 * "对话里说没记录、下一轮方案里却按它排了"的矛盾，所以放在这里共用。
 */
const { TYPE_LABEL, describeCompletion } = require('./reminderText')

/**
 * 把时间截成 2026-09-21（**本地时区**）。
 *
 * 坑：`plant_journal.created_at` 是 SQLite 的 `datetime('now')`，存的是 UTC 但没有时区标记
 * （'YYYY-MM-DD HH:MM:SS'），直接 new Date 会当成本地时间，晚上写的数据会差一天。
 * 带 'T' 的是 ISO 串（带 Z），直接用即可。
 */
function dayText(value) {
  if (!value) return ''
  const raw = String(value).trim()
  if (!raw) return ''
  const parsed = raw.indexOf('T') >= 0
    ? new Date(raw)
    : new Date(raw.replace(' ', 'T') + 'Z')
  if (isNaN(parsed.getTime())) return raw.slice(0, 10)
  const pad = (num) => (num < 10 ? '0' + num : '' + num)
  return parsed.getFullYear() + '-' + pad(parsed.getMonth() + 1) + '-' + pad(parsed.getDate())
}

/**
 * @param {object} db
 * @param {number} plantId
 * @param {object} [options]
 * @param {number} [options.journalLimit=6]
 * @param {number} [options.completionLimit=5]
 * @returns {{ journalLines: string[], completionLines: string[], lines: string[] }}
 */
function buildRecentActivity(db, plantId, options = {}) {
  const journalLimit = options.journalLimit === undefined ? 6 : options.journalLimit
  const completionLimit = options.completionLimit === undefined ? 5 : options.completionLimit

  const journalLines = []
  const completionLines = []

  if (journalLimit > 0) {
    const journals = db
      .prepare(`
        SELECT type, content, created_at, kind, occurred_at FROM plant_journal
        WHERE plant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
      `)
      .all(plantId, journalLimit)

    for (const item of journals) {
      const text = String(item.content || '').replace(/\s+/g, ' ').slice(0, 80)
      // kind='planned' 是"排了日子但还没做"（plan.js 写进去的），
      // 要说清楚，别让 AI 当成已经做过的记录；它的日期看 occurred_at（目标那天）
      if (item.kind === 'planned') {
        journalLines.push(
          `已排的计划（${dayText(item.occurred_at) || dayText(item.created_at)}，还没到日子）` +
          `：${text.replace(/^计划[:：]\s*/, '')}`
        )
      } else {
        journalLines.push(`日记（${dayText(item.created_at)}，${item.type}）：${text}`)
      }
    }
  }

  if (completionLimit > 0) {
    const completed = db
      .prepare(`
        SELECT type, title, completed_at, meta_json FROM plant_reminders
        WHERE plant_id = ? AND status = 'completed' AND completed_at IS NOT NULL
        ORDER BY completed_at DESC LIMIT ?
      `)
      .all(plantId, completionLimit)

    for (const item of completed) {
      const label = TYPE_LABEL[item.type] || item.title
      const detail = describeCompletion(item)
      completionLines.push(
        `已完成：${label}（${dayText(item.completed_at)}）` + (detail ? '，' + detail : '')
      )
    }
  }

  return { journalLines, completionLines, lines: [...journalLines, ...completionLines] }
}

module.exports = { buildRecentActivity, dayText }
