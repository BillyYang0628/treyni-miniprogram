const express = require('express')
const { getDb } = require('../db')

const router = express.Router()

router.get('/', (req, res) => {
  const db = getDb()
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()

  res.json({
    status: 'ok',
    service: 'treyni-miniprogram-server',
    timestamp: new Date().toISOString(),
    tables: tables.map((row) => row.name)
  })
})

module.exports = router
