const express = require('express')
const { getDb } = require('../db')
const { requireAuth } = require('../middleware/auth')
const { createDefaultRemindersForPlant } = require('../services/defaultReminders')
const waterPlan = require('../services/waterPlan')
const speciesOptions = require('../services/speciesOptions')
const { getDb: getDatabase } = require('../db')
const { getRequestBaseUrl, toPublicUrl, toStoredPath } = require('../services/imageUrl')

const router = express.Router()

router.use(requireAuth)

const editableFields = [
  'name',
  'species',
  'variety',
  'pot_size',
  'soil_type',
  'location',
  'light_environment',
  'planting_date',
  'soil_id',
  'exposure',
  'pot_depth_mm',
  'pot_diameter_mm',
  'growth_stage',
  'plant_source',
  'is_recent_transplant',
  'notes',
  'image_url',
  'status'
]

function mapPlant(row, baseUrl) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    species: row.species,
    variety: row.variety || '',
    pot_size: row.pot_size || '',
    soil_type: row.soil_type || '',
    location: row.location || '',
    light_environment: row.light_environment || '',
    planting_date: row.planting_date || '',
    soil_id: row.soil_id || '',
    exposure: row.exposure || '',
    pot_depth_mm: Number(row.pot_depth_mm) || 0,
    pot_diameter_mm: Number(row.pot_diameter_mm) || 0,
    growth_stage: row.growth_stage || '',
    plant_source: row.plant_source || '',
    is_recent_transplant: Number(row.is_recent_transplant) ? 1 : 0,
    transplanted_at: row.transplanted_at || '',
    notes: row.notes || '',
    image_url: toPublicUrl(row.image_url, baseUrl),
    status: row.status || 'active',
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

router.get('/', (req, res) => {
  const db = getDb()
  const baseUrl = getRequestBaseUrl(req)
  const plants = db
    .prepare('SELECT * FROM plants WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.user.id)

  res.json({
    plants: plants.map((row) => mapPlant(row, baseUrl))
  })
})

router.post('/', (req, res) => {
  const body = req.body || {}
  if (!body.name || !body.species) {
    return res.status(400).json({
      error: '植物名称和品种为必填项',
      code: 'MISSING_PLANT_FIELDS'
    })
  }

  const db = getDb()
  const result = db
    .prepare(`
      INSERT INTO plants (
        user_id, name, species, variety, pot_size, soil_type,
        location, light_environment, planting_date, growth_stage, plant_source,
        is_recent_transplant, transplanted_at, soil_id, exposure, pot_depth_mm, pot_diameter_mm,
        notes, image_url, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      req.user.id,
      body.name,
      body.species,
      body.variety || '',
      body.pot_size || '',
      body.soil_type || '',
      body.location || '',
      body.light_environment || '',
      body.planting_date || '',
      body.growth_stage || '',
      body.plant_source || '',
      Number(body.is_recent_transplant) ? 1 : 0,
      // 添加时就勾了"刚换盆/刚移栽"：起算点记成今天
      Number(body.is_recent_transplant) ? new Date().toISOString() : null,
      body.soil_id || '',
      body.exposure || '',
      Number(body.pot_depth_mm) || 0,
      Number(body.pot_diameter_mm) || 0,
      body.notes || '',
      toStoredPath(body.image_url),
      body.status || 'active'
    )

  const plant = db.prepare('SELECT * FROM plants WHERE id = ?').get(result.lastInsertRowid)
  createDefaultRemindersForPlant(db, plant)

  // 物种级用品候选：添加植物时后台生成一次，同品种之后共用。
  // 异步、失败也不影响建植物（见 services/speciesOptions.js）。
  speciesOptions.ensureInBackground(plant.species)

  // 有城市信息时，浇水提醒直接按天气模型算日期（没设置城市则先按知识库间隔）
  const watering = getDatabase()
    .prepare("SELECT id FROM plant_reminders WHERE plant_id = ? AND type = 'watering' AND status = 'pending' ORDER BY due_at LIMIT 1")
    .get(plant.id)

  if (watering) {
    waterPlan.applyToReminder(watering.id).catch((err) => {
      console.warn('[water] 新植物浇水提醒计算失败：' + err.message)
    })
  }

  res.status(201).json({ plant: mapPlant(plant, getRequestBaseUrl(req)) })
})

router.get('/:id', (req, res) => {
  const db = getDb()
  const plant = db
    .prepare('SELECT * FROM plants WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id)

  if (!plant) {
    return res.status(404).json({
      error: '植物不存在',
      code: 'PLANT_NOT_FOUND'
    })
  }

  res.json({ plant: mapPlant(plant, getRequestBaseUrl(req)) })
})

router.put('/:id', (req, res) => {
  const db = getDb()
  const existing = db
    .prepare('SELECT * FROM plants WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id)

  if (!existing) {
    return res.status(404).json({
      error: '植物不存在',
      code: 'PLANT_NOT_FOUND'
    })
  }

  const fields = []
  const values = []

  for (const field of editableFields) {
    if (req.body && req.body[field] !== undefined) {
      fields.push(`${field} = ?`)
      values.push(field === 'image_url' ? toStoredPath(req.body[field]) : req.body[field])
    }
  }

  /**
   * 勾上"刚换盆/刚移栽"的那一刻，把换盆日期记成现在。
   *
   * 这是一个**已存在的 bug** 的修复：缓苗期原本以 created_at 起算，
   * 所以养了几个月之后才在编辑页里勾这个开关，缓苗期会当场失效（created_at + 14 天早过了）。
   * 只在 0 → 1 这一次写，之后反复保存档案不会把缓苗期重置。
   */
  if (req.body && req.body.is_recent_transplant !== undefined) {
    const next = Number(req.body.is_recent_transplant) ? 1 : 0
    const prev = Number(existing.is_recent_transplant) ? 1 : 0
    if (next === 1 && prev === 0) {
      fields.push('transplanted_at = ?')
      values.push(new Date().toISOString())
    }
  }

  if (!fields.length) {
    return res.status(400).json({
      error: '没有需要更新的字段',
      code: 'NOTHING_TO_UPDATE'
    })
  }

  fields.push("updated_at = datetime('now')")
  values.push(req.params.id, req.user.id)
  db.prepare(`UPDATE plants SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).run(...values)

  const plant = db.prepare('SELECT * FROM plants WHERE id = ?').get(req.params.id)
  res.json({ plant: mapPlant(plant, getRequestBaseUrl(req)) })
})

router.delete('/:id', (req, res) => {
  const db = getDb()
  const result = db
    .prepare('DELETE FROM plants WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.user.id)

  if (!result.changes) {
    return res.status(404).json({
      error: '植物不存在',
      code: 'PLANT_NOT_FOUND'
    })
  }

  res.status(204).end()
})

module.exports = router
