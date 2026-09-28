/**
 * 物种级「常见用品候选」。
 *
 * 为什么要有这一层（用户 2026-09-18 的要求）：
 *   同一种植物会用的常见药、肥，同一个品种两盆植物是一样的，
 *   没必要每盆、每条提醒都让 AI 重新想一遍。
 *   所以**添加植物时生成一次、按品种缓存**，之后该品种所有植物共用。
 *
 * 两层分工：
 *   物种级（这里）     「这个品种常见的药/肥有哪些」——稳定、可缓存、不花钱
 *   方案级（options_json）「这一次具体怎么配、要问用户什么」——每次生成方案时产出
 *
 * 生成是**异步**的，绝不挡在添加植物的同步路径上：
 * AI 没回来（或没配 key、超时）之前，完成面板用四类通用的兜底选项，
 * 生成好了下次打开面板自动就用上了。
 */
const { getDb } = require('../db')
const aiAdapter = require('./aiAdapter')

// 浇水不在这里：完成面板问的是"浇到什么程度"，不是"用了什么牌子"，
// 那属于方案级的实时问题。
const SPECIES_KINDS = ['fertilizing', 'pesticide', 'pruning']

// 同一个品种被多盆植物同时触发时，只生成一次
const inflight = new Set()

function parseOptions(text) {
  try {
    const value = text ? JSON.parse(text) : null
    return value && typeof value === 'object' ? value : null
  } catch (e) {
    return null
  }
}

/** 读缓存；没有返回 null（老品种、还没生成完） */
function getCached(species) {
  const key = String(species || '').trim()
  if (!key) return null

  try {
    const row = getDb()
      .prepare('SELECT options_json FROM species_care_options WHERE species = ?')
      .get(key)
    return row ? parseOptions(row.options_json) : null
  } catch (e) {
    return null
  }
}

function save(species, options) {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO species_care_options (species, options_json, ai_model, updated_at)
    VALUES (?, ?, 'ai', ?)
    ON CONFLICT(species) DO UPDATE SET
      options_json = excluded.options_json,
      ai_model = excluded.ai_model,
      updated_at = excluded.updated_at
  `).run(species, JSON.stringify(options || {}), now)
}

/**
 * 生成并缓存。同步调用会立刻返回（后台跑），重复调用会被 in-flight 锁挡掉。
 * @returns {Promise<object|null>} 生成成功返回 options，失败返回 null（不抛）
 */
function ensure(species, careGroup) {
  const key = String(species || '').trim()
  if (!key) return Promise.resolve(null)

  const cached = getCached(key)
  if (cached) return Promise.resolve(cached)
  if (inflight.has(key)) return Promise.resolve(null)

  inflight.add(key)
  return aiAdapter
    .generateSpeciesCareOptions(key, careGroup)
    .then((options) => {
      save(key, options)
      return options
    })
    .catch((err) => {
      // 生成失败不影响任何主流程：面板会退回通用兜底选项
      console.warn('[speciesOptions] 「' + key + '」候选生成失败：' + err.message)
      return null
    })
    .then((result) => {
      inflight.delete(key)
      return result
    })
}

/** 后台触发，不阻塞调用方 */
function ensureInBackground(species, careGroup) {
  ensure(species, careGroup).catch(() => {})
}

/** 某条提醒能用的物种级候选（没有就返回 []) */
function optionsFor(species, type) {
  if (SPECIES_KINDS.indexOf(type) < 0) return []
  const cached = getCached(species)
  const list = cached && Array.isArray(cached[type]) ? cached[type] : []
  return list.filter((item) => typeof item === 'string' && item.trim()).slice(0, 4)
}

module.exports = {
  SPECIES_KINDS,
  getCached,
  save,
  ensure,
  ensureInBackground,
  optionsFor
}
