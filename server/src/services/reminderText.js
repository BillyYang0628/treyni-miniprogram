const TYPE_LABEL = {
  watering: '浇水',
  fertilizing: '施肥',
  pesticide: '打药',
  pruning: '修剪',
  repot: '换盆',
  treatment: '喷药',
  treatment_feedback: '用药效果反馈',
  custom: '养护记录'
}

/**
 * 迟做的原因。措辞按《措辞规范》：陈述事实、不评价人、选项本身不带责备。
 * 放在这里是因为两处都要用：完成接口写养护历程时、给下一轮 AI 的历史里。
 */
const LATE_REASON_LABEL = {
  forgot: '最近没顾上',
  weather: '天气不合适',
  already_done: '其实已经做过了',
  not_needed: '这段时间不需要做',
  other: '其他原因'
}

/** 从提醒的 meta_json 里读出这次完成登记了什么 */
function readCompletion(metaJson) {
  try {
    const meta = metaJson ? JSON.parse(metaJson) : {}
    return meta.completion || null
  } catch (e) {
    return null
  }
}

/**
 * 把一次完成登记压成一行给 AI 看的话。
 * 这是第 5 期"结构化记录喂 AI"的核心：以前这里只有"已完成：打药"，
 * AI 根本不知道用户实际用了什么药，只能照着知识库重排。
 */
function describeCompletion(reminder) {
  const done = readCompletion(reminder && reminder.meta_json)
  if (!done) return ''

  const parts = []
  if (done.done_items && done.done_items.length) {
    parts.push('实际用了/做了：' + done.done_items.join('、'))
  } else if (done.unsure) {
    // 用户明确说"说不清"或整题跳过 —— 不能当成"按方案做了"
    parts.push('实际做了什么未登记')
  }
  if (done.late_reason && done.late_reason !== 'already_done') {
    parts.push('这次晚了的原因：' + (LATE_REASON_LABEL[done.late_reason] || done.late_reason))
  }
  if (done.note) parts.push('备注：' + done.note)
  return parts.join('；')
}

const TYPE_HINT = {
  watering: '盆土干透再浇透',
  fertilizing: '用稀薄液肥沿盆边浇',
  pesticide: '全株喷药，重点喷叶片背面',
  pruning: '剪掉枯枝病叶，保持通风',
  repot: '检查根系，换到更合适的花盆和土'
}

/**
 * 列表里显示的一句话摘要。
 * 这里用模板生成，保证添加植物、完成提醒等操作可以立刻响应，不需要等待 AI。
 */
function buildReminderSummary(reminder, plantName) {
  if (!reminder) return ''

  const name = plantName || '植物'
  const type = reminder.type

  if (TYPE_HINT[type]) {
    return `给${name}${TYPE_LABEL[type]}：${TYPE_HINT[type]}`
  }

  if (type === 'treatment') {
    const disease = String(reminder.title || '').replace(/^喷药处理[:：]?/, '').trim()
    return disease ? `处理${disease}：按方案喷药并注意安全` : '按方案喷药并注意安全'
  }

  if (type === 'treatment_feedback') {
    return '反馈用药效果：看看病虫害有没有好转'
  }

  return reminder.title || '养护提醒'
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * 距离到期还有几天，按自然日算。负数表示已经逾期。
 * 逾期渐变（边框从近黑过渡到明红）需要这个数字，所以单独暴露出来。
 */
function daysUntilDue(dueAt, now = new Date()) {
  if (!dueAt) return null
  const due = new Date(dueAt)
  if (isNaN(due.getTime())) return null
  return Math.round((startOfDay(due) - startOfDay(now)) / (24 * 60 * 60 * 1000))
}

/** 相对日期标签，例如 今天 / 明天 / 3天后 / 已逾期2天 */
function buildDueLabel(dueAt, now = new Date()) {
  const diffDays = daysUntilDue(dueAt, now)
  if (diffDays === null) return ''

  const due = new Date(dueAt)

  if (diffDays < 0) return `已逾期${-diffDays}天`
  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '明天'
  if (diffDays === 2) return '后天'
  if (diffDays <= 7) return `${diffDays}天后`

  return `${due.getMonth() + 1}月${due.getDate()}日`
}

/** 完整时间文案，例如 9月13日 22:03 */
function buildDueText(dueAt) {
  if (!dueAt) return ''

  const date = new Date(dueAt)
  if (isNaN(date.getTime())) return ''

  const pad = (value) => (value < 10 ? '0' + value : '' + value)
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

module.exports = {
  TYPE_LABEL,
  LATE_REASON_LABEL,
  readCompletion,
  describeCompletion,
  buildReminderSummary,
  buildDueLabel,
  buildDueText,
  daysUntilDue
}
