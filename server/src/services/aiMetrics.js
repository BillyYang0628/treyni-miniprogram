/**
 * AI 调用耗时记录：每次调用追加一行 JSON 到 server/data/ai_metrics.jsonl。
 * 字段：ts / label / provider / model / thinking / effort / ms / promptChars / outputChars / usage / ok / error
 * 用途：定位"AI 慢在哪"，以及换供应商前后的对照证据。AI_METRICS=0 可关闭。
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const config = require('../config')

const FILE = path.resolve(config.rootDir, 'data', 'ai_metrics.jsonl')
const ENABLED = String(process.env.AI_METRICS || '1') !== '0'

let warned = false

/** 统计提示词规模（图片按 base64 长度估算） */
function promptChars(messages) {
  let total = 0
  for (const message of messages || []) {
    const content = message && message.content
    if (typeof content === 'string') {
      total += content.length
      continue
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part.text === 'string') total += part.text.length
        if (part && part.image_url && typeof part.image_url.url === 'string') {
          total += part.image_url.url.length
        }
      }
    }
  }
  return total
}

/**
 * 提示词指纹（2026-09-21 加）：只对 **system 消息**取 sha1 前 8 位。
 *
 * 为什么只算 system：那里面才是"写法要求 / 条款"这类版本化的东西；
 * 历史对话、知识库块、图片每次都不一样，算进去指纹每次都会变，就失去意义了。
 * 用途：改完提示词跑一轮，从 ai_metrics.jsonl 里就能看出某条记录是不是新版本产出的
 * （方案文档里建议过这件事：提示词过审不能只是纸面同意）。
 *
 * 纯附加字段，不影响请求内容，也不影响任何判断逻辑。
 */
function promptHash(messages) {
  const lines = []
  for (const message of messages || []) {
    if (!message || message.role !== 'system') continue
    const content = message.content
    if (typeof content === 'string') {
      lines.push(content)
      continue
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part.text === 'string') lines.push(part.text)
      }
    }
  }
  if (!lines.length) return 'no-system'
  return crypto.createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 8)
}

function record(entry) {
  if (!ENABLED) return
  try {
    fs.appendFileSync(FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch (err) {
    if (!warned) {
      warned = true
      console.warn('[aiMetrics] 写入耗时记录失败：' + err.message)
    }
  }
}

module.exports = { record, promptChars, promptHash, FILE }
