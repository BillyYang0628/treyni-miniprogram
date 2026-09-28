const express = require('express')
const { getDb } = require('../db')
const { requireAuth } = require('../middleware/auth')
const { getRequestBaseUrl, toPublicUrl, toStoredPath } = require('../services/imageUrl')

const router = express.Router()

router.use(requireAuth)

function getOwnedPlant(db, plantId, userId) {
  return db
    .prepare('SELECT * FROM plants WHERE id = ? AND user_id = ?')
    .get(plantId, userId)
}

function mapJournal(row, baseUrl) {
  return {
    id: row.id,
    plant_id: row.plant_id,
    type: row.type,
    content: row.content || '',
    image_url: toPublicUrl(row.image_url, baseUrl),
    // done = 已经发生的记录；planned = 计划中的事
    kind: row.kind || 'done',
    // 这件事实际发生（或计划发生）的日期；老数据为空，页面退回用 created_at
    occurred_at: row.occurred_at || '',
    created_at: row.created_at
  }
}

router.get('/plants/:id/journal', (req, res) => {
  const db = getDb()
  const baseUrl = getRequestBaseUrl(req)
  const plant = getOwnedPlant(db, req.params.id, req.user.id)

  if (!plant) {
    return res.status(404).json({
      error: '植物不存在',
      code: 'PLANT_NOT_FOUND'
    })
  }

  const journals = db
    .prepare('SELECT * FROM plant_journal WHERE plant_id = ? ORDER BY created_at DESC, id DESC')
    .all(plant.id)

  res.json({
    journals: journals.map((row) => mapJournal(row, baseUrl))
  })
})

router.post('/plants/:id/journal', (req, res) => {
  const db = getDb()
  const plant = getOwnedPlant(db, req.params.id, req.user.id)

  if (!plant) {
    return res.status(404).json({
      error: '植物不存在',
      code: 'PLANT_NOT_FOUND'
    })
  }

  const type = req.body && req.body.type
  const content = req.body && req.body.content
  const imageUrl = toStoredPath(req.body && req.body.image_url)

  if (!type) {
    return res.status(400).json({
      error: '日记类型不能为空',
      code: 'JOURNAL_TYPE_REQUIRED'
    })
  }

  const result = db
    .prepare(`
      INSERT INTO plant_journal (plant_id, user_id, type, content, image_url)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(plant.id, req.user.id, type, content || '', imageUrl || '')

  const journal = db.prepare('SELECT * FROM plant_journal WHERE id = ?').get(result.lastInsertRowid)
  res.status(201).json({ journal: mapJournal(journal, getRequestBaseUrl(req)) })
})

// 养护历程详情：列表点进来时读取完整内容
router.get('/journals/:id', (req, res) => {
  const db = getDb()
  const journal = db
    .prepare('SELECT * FROM plant_journal WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id)

  if (!journal) {
    return res.status(404).json({
      error: '养护记录不存在',
      code: 'JOURNAL_NOT_FOUND'
    })
  }

  const plant = db.prepare('SELECT * FROM plants WHERE id = ?').get(journal.plant_id)

  res.json({
    journal: mapJournal(journal, getRequestBaseUrl(req)),
    plant: plant
      ? {
          id: plant.id,
          name: plant.name,
          species: plant.species,
          variety: plant.variety || ''
        }
      : null
  })
})

module.exports = router
