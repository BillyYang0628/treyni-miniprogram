const express = require('express')
const fs = require('node:fs')
const path = require('node:path')
const config = require('../config')
const { getDb } = require('../db')
const { requireAuth } = require('../middleware/auth')
const aiAdapter = require('../services/aiAdapter')
const { createInitialTreatmentPair } = require('../services/treatment')
const { getRequestBaseUrl, toPublicUrl, toStoredPath } = require('../services/imageUrl')

const router = express.Router()

router.use(requireAuth)

const REFERENCE_NOTE = '百度植物识别的参考结果，仅作参考，本植物的品种以档案为准'

const SEVERITY_TEXT = {
  mild: '轻微',
  moderate: '中等',
  severe: '严重',
  healthy: '未见异常',
  unknown: '待确认'
}

function getOwnedPlant(db, plantId, userId) {
  return db
    .prepare('SELECT * FROM plants WHERE id = ? AND user_id = ?')
    .get(plantId, userId)
}

function getPlantOrThrow(db, plantId, userId) {
  const plant = getOwnedPlant(db, plantId, userId)

  if (!plant) {
    const err = new Error('植物不存在')
    err.code = 'PLANT_NOT_FOUND'
    err.status = 404
    throw err
  }

  return plant
}

function mapJournal(row, baseUrl) {
  return {
    id: row.id,
    plant_id: row.plant_id,
    type: row.type,
    content: row.content || '',
    image_url: toPublicUrl(row.image_url, baseUrl),
    created_at: row.created_at
  }
}

function plantContext(plant) {
  return {
    name: plant.name,
    species: plant.species,
    variety: plant.variety || '',
    pot_size: plant.pot_size || '',
    soil_type: plant.soil_type || '',
    location: plant.location || '',
    light_environment: plant.light_environment || '',
    source: 'profile'
  }
}

function isMissingFields(body) {
  const plantId = body && body.plant_id
  const hasImage = Boolean((body && body.relative_path) || (body && body.image_url))
  return !plantId || !hasImage
}

/**
 * 读取待诊断的图片。
 * 返回给 AI 的是 base64，写入数据库的是不含域名的相对路径。
 */
function readImagePayload(body) {
  const relativePath = body && body.relative_path
  const imageUrl = body && body.image_url

  if (!relativePath) {
    return {
      imageForAI: imageUrl || '',
      storedPath: toStoredPath(imageUrl || '')
    }
  }

  const storageRoot = path.resolve(config.storageRoot)
  const storageRootWithSep = storageRoot.endsWith(path.sep) ? storageRoot : storageRoot + path.sep
  const absolutePath = path.resolve(storageRoot, relativePath.replace(/^\\/g, '/').replace(/^\/+/, ''))

  if (!absolutePath.startsWith(storageRootWithSep)) {
    const err = new Error('非法的图片路径')
    err.code = 'INVALID_IMAGE_PATH'
    err.status = 400
    throw err
  }

  if (!fs.existsSync(absolutePath)) {
    const err = new Error('图片文件不存在，请重新上传后再诊断')
    err.code = 'IMAGE_NOT_FOUND'
    err.status = 404
    throw err
  }

  return {
    imageForAI: fs.readFileSync(absolutePath).toString('base64'),
    storedPath: toStoredPath(relativePath)
  }
}

/**
 * 百度植物识别只作为参考线索：
 * - label / label_confidence 作为“参考识别”返回
 * - 只有命中病虫害关键词时，才作为病害线索
 */
function buildDiagnosis(plant, baidu) {
  const disease = String(baidu.disease || '').trim()

  return {
    plant: plantContext(plant),
    identification: {
      label: baidu.label || '',
      confidence: typeof baidu.label_confidence === 'number' ? baidu.label_confidence : null,
      baike: baidu.baike || null,
      note: REFERENCE_NOTE
    },
    disease,
    disease_confidence: disease ? (baidu.disease_confidence || null) : null,
    severity: disease ? 'unknown' : 'healthy',
    evidence: '',
    is_healthy: !disease,
    source: 'baidu'
  }
}

/**
 * 落库前的最终诊断结果。
 * 植物一律取档案数据，忽略客户端传来的任何植物品种信息。
 */
function normalizeFinalDiagnosis(plant, incoming = {}) {
  const disease = String(incoming.disease || '').trim()
  const rawConfidence = incoming.disease_confidence !== undefined
    ? incoming.disease_confidence
    : incoming.confidence

  return {
    plant: plantContext(plant),
    identification: incoming.identification || {
      label: '',
      confidence: null,
      baike: null,
      note: REFERENCE_NOTE
    },
    disease,
    disease_confidence: typeof rawConfidence === 'number' ? rawConfidence : null,
    severity: disease ? (incoming.severity || 'unknown') : 'healthy',
    evidence: incoming.evidence || '',
    is_healthy: !disease,
    source: incoming.source || 'baidu'
  }
}

async function saveDiagnosis(db, plant, userId, imageStoredPath, diagnosis) {
  let treatmentText = ''
  let summaryText = ''

  if (diagnosis.disease) {
    // 一次生成两段内容：用药指导给“每日提醒”，病害介绍给“植物养护历程”
    const report = await aiAdapter.generateDiagnosisReport(plant, diagnosis)
    treatmentText = report.treatment
    summaryText = report.summary
  }

  // 养护历程只记录病害情况，不重复写入具体打药流程
  const journalContent = diagnosis.disease
    ? [
        `疑似问题：${diagnosis.disease}（严重程度：${SEVERITY_TEXT[diagnosis.severity] || '待确认'}）`,
        '',
        summaryText
      ].join('\n')
    : '本次诊断未发现明显病虫害，叶片状态正常。'

  const journalResult = db
    .prepare(`
      INSERT INTO plant_journal (plant_id, user_id, type, content, image_url)
      VALUES (?, ?, 'diagnosis', ?, ?)
    `)
    .run(plant.id, userId, journalContent, imageStoredPath || '')

  const journal = db.prepare('SELECT * FROM plant_journal WHERE id = ?').get(journalResult.lastInsertRowid)

  let treatmentReminder = null
  let feedbackReminder = null

  if (diagnosis.disease) {
    const pair = createInitialTreatmentPair(db, plant, userId, {
      treatmentTitle: `喷药处理：${diagnosis.disease}`,
      treatmentContent: treatmentText || '根据 AI 诊断结果执行首次喷药处理，并观察叶片变化。',
      feedbackTitle: '用药效果询问（第 1 轮）',
      feedbackContent: '请确认首次用药后，病虫害是否有明显改善。',
      disease: diagnosis.disease
    })
    treatmentReminder = pair.treatment
    feedbackReminder = pair.feedback
  }

  return {
    diagnosis: {
      ...diagnosis,
      treatment: treatmentText,
      disease_summary: summaryText
    },
    journal,
    treatmentReminder,
    feedbackReminder
  }
}

function summarizeReminder(reminder) {
  if (!reminder) return null
  return {
    id: reminder.id,
    type: reminder.type,
    title: reminder.title,
    due_at: reminder.due_at
  }
}

// 第一步：百度植物识别，返回参考识别结果和可能的病虫害线索
router.post('/recognize', async (req, res, next) => {
  try {
    if (isMissingFields(req.body)) {
      return res.status(400).json({
        error: 'plant_id 以及 image_url 或 relative_path 为必填项',
        code: 'MISSING_DIAGNOSIS_FIELDS'
      })
    }

    const { imageForAI } = readImagePayload(req.body)
    const db = getDb()
    const plant = getPlantOrThrow(db, req.body.plant_id, req.user.id)
    const baidu = await aiAdapter.diagnosePlant(imageForAI, plantContext(plant))

    res.json({ diagnosis: buildDiagnosis(plant, baidu) })
  } catch (err) {
    next(err)
  }
})

// 第二步：Kimi 视觉复核，只在百度结果不足时调用
router.post('/vision-review', async (req, res, next) => {
  try {
    if (isMissingFields(req.body)) {
      return res.status(400).json({
        error: 'plant_id 以及 image_url 或 relative_path 为必填项',
        code: 'MISSING_DIAGNOSIS_FIELDS'
      })
    }

    const { imageForAI } = readImagePayload(req.body)
    const db = getDb()
    const plant = getPlantOrThrow(db, req.body.plant_id, req.user.id)
    const vision = await aiAdapter.diagnoseDiseaseWithVision(imageForAI, plant)

    res.json({ vision })
  } catch (err) {
    next(err)
  }
})

// 第三步：生成用药指导，写入养护日记，并创建喷药提醒和用药效果询问提醒
router.post('/finalize', async (req, res, next) => {
  try {
    if (isMissingFields(req.body) || !(req.body && req.body.diagnosis)) {
      return res.status(400).json({
        error: 'plant_id、图片路径和 diagnosis 为必填项',
        code: 'MISSING_FINALIZE_FIELDS'
      })
    }

    const { storedPath } = readImagePayload(req.body)
    const db = getDb()
    const plant = getPlantOrThrow(db, req.body.plant_id, req.user.id)
    const diagnosis = normalizeFinalDiagnosis(plant, req.body.diagnosis)

    const result = await saveDiagnosis(db, plant, req.user.id, storedPath, diagnosis)

    res.status(201).json({
      diagnosis: result.diagnosis,
      journal: mapJournal(result.journal, getRequestBaseUrl(req)),
      treatment_reminder: summarizeReminder(result.treatmentReminder),
      feedback_reminder: summarizeReminder(result.feedbackReminder)
    })
  } catch (err) {
    next(err)
  }
})

// 一次性完成识别、复核和落库，便于脚本或后续接口复用
router.post('/', async (req, res, next) => {
  try {
    if (isMissingFields(req.body)) {
      return res.status(400).json({
        error: 'plant_id 以及 image_url 或 relative_path 为必填项',
        code: 'MISSING_DIAGNOSIS_FIELDS'
      })
    }

    const { imageForAI, storedPath } = readImagePayload(req.body)
    const db = getDb()
    const plant = getPlantOrThrow(db, req.body.plant_id, req.user.id)
    const baidu = await aiAdapter.diagnosePlant(imageForAI, plantContext(plant))
    const diagnosis = buildDiagnosis(plant, baidu)

    if (!diagnosis.disease || diagnosis.disease_confidence === null || diagnosis.disease_confidence < 0.6) {
      try {
        const vision = await aiAdapter.diagnoseDiseaseWithVision(imageForAI, plant)
        if (vision.has_disease && vision.disease) {
          diagnosis.disease = vision.disease
          diagnosis.disease_confidence = vision.confidence
          diagnosis.severity = vision.severity
          diagnosis.evidence = vision.evidence
          diagnosis.is_healthy = false
          diagnosis.source = 'baidu+kimi_vision'
        }
      } catch (visionErr) {
        diagnosis.vision_error = visionErr.message || 'Kimi 视觉复核失败'
      }
    }

    const result = await saveDiagnosis(db, plant, req.user.id, storedPath, diagnosis)

    res.status(201).json({
      diagnosis: result.diagnosis,
      journal: mapJournal(result.journal, getRequestBaseUrl(req)),
      treatment_reminder: summarizeReminder(result.treatmentReminder),
      feedback_reminder: summarizeReminder(result.feedbackReminder)
    })
  } catch (err) {
    next(err)
  }
})

router.get('/history/:plantId', (req, res) => {
  const db = getDb()
  const baseUrl = getRequestBaseUrl(req)
  const plant = getOwnedPlant(db, req.params.plantId, req.user.id)

  if (!plant) {
    return res.status(404).json({
      error: '植物不存在',
      code: 'PLANT_NOT_FOUND'
    })
  }

  const journals = db
    .prepare(`
      SELECT * FROM plant_journal
      WHERE plant_id = ? AND type = 'diagnosis'
      ORDER BY created_at DESC, id DESC
    `)
    .all(plant.id)

  res.json({
    history: journals.map((row) => mapJournal(row, baseUrl))
  })
})

module.exports = router
