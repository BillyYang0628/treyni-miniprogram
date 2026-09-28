/**
 * 微信订阅消息推送
 * 模板 ID 需要在小程序后台申请后填入 .env：WECHAT_SUBSCRIBE_TEMPLATE_ID
 * 没有配置模板时不会静默跳过，而是返回明确原因，前端/日志都能看到。
 */
const config = require('../config')
const wechatToken = require('./wechatToken')

const TYPE_TEXT = {
  watering: '浇水',
  fertilizing: '施肥',
  pesticide: '打药',
  pruning: '修剪',
  treatment: '喷药处理',
  treatment_feedback: '用药效果反馈',
  custom: '养护提醒'
}

const MAX_TEXT_LENGTH = 20

function isConfigured() {
  return Boolean(config.wechat.subscribeTemplateId)
}

function truncate(text, limit = MAX_TEXT_LENGTH) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  if (!value) return ''
  return value.length > limit ? value.slice(0, limit - 1) + '…' : value
}

/** 微信 time 类型要求 "2026年9月15日 09:00" 这类格式 */
function formatPushTime(value) {
  const date = new Date(value)
  if (isNaN(date.getTime())) return ''
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 把提醒翻译成推送文案。
 * 模板：植物定期养护提醒
 *   植物名称 thing1 / 事项名称 thing2 / 提醒时间 time3 / 备注 thing4
 */
function buildMessage(reminder, plant, waterState) {
  const typeText = TYPE_TEXT[reminder.type] || '养护'
  const plantName = truncate((plant && plant.name) || '你的植物')

  // 备注优先说明天气结论，其次用知识库给的提示
  const summaryText = String(reminder.summary_text || reminder.title || '')
  let remark = summaryText.includes('：')
    ? summaryText.split('：').slice(1).join('：')
    : summaryText

  if (reminder.type === 'watering' && waterState) {
    const rained = waterState.rain_reset_days && waterState.rain_reset_days.length
    if (rained) {
      remark = '已下雨，相当于浇过一次水'
    } else if (waterState.city) {
      remark = `已结合${waterState.city}天气安排`
    }
  }

  return {
    thing1: { value: plantName },
    thing2: { value: truncate(typeText) },
    time3: { value: formatPushTime(reminder.due_at) },
    thing4: { value: truncate(remark) || truncate(reminder.title) }
  }
}

async function send(openid, templateId, data, page) {
  const token = await wechatToken.getAccessToken()

  const response = await fetch(
    'https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=' + token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: openid,
        template_id: templateId,
        page: page || 'pages/garden/garden',
        data,
        miniprogram_state: config.wechat.miniprogramState,
        lang: 'zh_CN'
      }),
      signal: AbortSignal.timeout(10000)
    }
  )

  const result = await response.json()

  if (result.errcode && result.errcode !== 0) {
    const err = new Error('订阅消息发送失败：' + result.errcode + ' ' + (result.errmsg || ''))
    err.code = 'WECHAT_PUSH_' + result.errcode
    err.status = 502
    err.errcode = result.errcode
    throw err
  }

  return { ok: true, raw: result }
}

/** 统一入口：没配模板时返回 skipped 与原因，不静默 */
async function pushReminder({ openid, reminder, plant, waterState }) {
  if (!isConfigured()) {
    return { skipped: true, reason: '未配置订阅消息模板 ID（WECHAT_SUBSCRIBE_TEMPLATE_ID）' }
  }
  if (!openid) {
    return { skipped: true, reason: '用户没有 openid' }
  }

  const data = buildMessage(reminder, plant, waterState)
  const result = await send(openid, config.wechat.subscribeTemplateId, data, 'pages/reminder-detail/reminder-detail?id=' + reminder.id)

  return { skipped: false, data, result }
}

module.exports = {
  TYPE_TEXT,
  MAX_TEXT_LENGTH,
  isConfigured,
  truncate,
  formatPushTime,
  buildMessage,
  send,
  pushReminder
}
