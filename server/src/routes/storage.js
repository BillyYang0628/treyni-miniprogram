const express = require('express')
const multer = require('multer')
const storageService = require('../services/storage')
const { getRequestBaseUrl, toPublicUrl } = require('../services/imageUrl')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
})

router.post('/storage', requireAuth, upload.single('file'), (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: '请选择要上传的文件',
        code: 'FILE_REQUIRED'
      })
    }

    const category = req.body && req.body.category
      ? req.body.category
      : 'misc'

    const saved = storageService.save(req.file.buffer, category, req.file.originalname)

    res.status(201).json({
      url: toPublicUrl(saved.relativePath, getRequestBaseUrl(req)),
      relative_path: saved.relativePath
    })
  } catch (err) {
    next(err)
  }
})

router.delete('/storage', requireAuth, (req, res, next) => {
  try {
    const relativePath = req.body && req.body.relative_path

    if (!relativePath) {
      return res.status(400).json({
        error: '缺少 relative_path',
        code: 'MISSING_RELATIVE_PATH'
      })
    }

    const removed = storageService.remove(relativePath)
    if (!removed) {
      return res.status(404).json({
        error: '文件不存在或无法删除',
        code: 'FILE_NOT_FOUND'
      })
    }

    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

module.exports = router
