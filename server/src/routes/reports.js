const express = require('express')
const { getDb } = require('../db')
const { requireAuth } = require('../middleware/auth')
const careReport = require('../services/careReport')

const router = express.Router()

router.use(requireAuth)

function getOwnedPlant(db, plantId, userId) {
  return db.prepare('SELECT * FROM plants WHERE id = ? AND user_id = ?').get(plantId, userId)
}

// 生成一份报告（异步，返回请求号用于轮询）
router.post('/plants/:id/report', (req, res) => {
  const db = getDb()
  const plant = getOwnedPlant(db, req.params.id, req.user.id)

  if (!plant) {
    return res.status(404).json({
      error: '植物不存在',
      code: 'PLANT_NOT_FOUND'
    })
  }

  const request = careReport.createRequest(plant.id, req.user.id, req.body || {})
  if (!request) {
    return res.status(400).json({
      error: '无法创建报告请求',
      code: 'REPORT_REQUEST_FAILED'
    })
  }

  careReport.scheduleGeneration(request.id)

  res.status(202).json({
    request_id: request.id,
    status: 'generating',
    message: '报告生成中，通常需要 1-3 分钟'
  })
})

// 轮询生成状态
router.get('/report-requests/:id', (req, res) => {
  const db = getDb()
  const request = db
    .prepare('SELECT * FROM report_requests WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id)

  if (!request) {
    return res.status(404).json({
      error: '请求不存在',
      code: 'REQUEST_NOT_FOUND'
    })
  }

  let report = null
  if (request.status === 'completed') {
    const row = db
      .prepare('SELECT * FROM reports WHERE request_id = ? ORDER BY id DESC LIMIT 1')
      .get(request.id)
    report = careReport.mapReport(row)
  }

  res.json({
    request: careReport.mapRequest(request),
    report
  })
})

// 某盆植物的报告历史
router.get('/plants/:id/reports', (req, res) => {
  const db = getDb()
  const plant = getOwnedPlant(db, req.params.id, req.user.id)

  if (!plant) {
    return res.status(404).json({
      error: '植物不存在',
      code: 'PLANT_NOT_FOUND'
    })
  }

  const rows = db
    .prepare('SELECT * FROM reports WHERE plant_id = ? ORDER BY id DESC LIMIT 20')
    .all(plant.id)

  res.json({ reports: rows.map(careReport.mapReport) })
})

// 报告详情
router.get('/reports/:id', (req, res) => {
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM reports WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id)

  if (!row) {
    return res.status(404).json({
      error: '报告不存在',
      code: 'REPORT_NOT_FOUND'
    })
  }

  res.json({ report: careReport.mapReport(row) })
})

router.delete('/reports/:id', (req, res) => {
  const db = getDb()
  const result = db
    .prepare('DELETE FROM reports WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.user.id)

  if (!result.changes) {
    return res.status(404).json({
      error: '报告不存在',
      code: 'REPORT_NOT_FOUND'
    })
  }

  res.status(204).end()
})

module.exports = router
