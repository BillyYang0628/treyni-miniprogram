const express = require('express')
const { getDb } = require('../db')
const { requireAuth } = require('../middleware/auth')
const aiAdapter = require('../services/aiAdapter')
const gardener = require('../services/gardener')
const waterPlan = require('../services/waterPlan')
const waterBaseline = require('../services/waterBaseline')

const router = express.Router()

router.use(requireAuth)

function getOwnedPlant(db, plantId, userId) {
  return db.prepare('SELECT * FROM plants WHERE id = ? AND user_id = ?').get(plantId, userId)
}

function mapMessage(row) {
  return {
    role: row.role,
    content: row.content,
    created_at: row.created_at
  }
}

// 进入对话：返回会话、历史消息、植物档案和待确认变更
router.get('/chat/gardener/session/:plantId', (req, res) => {
  const db = getDb()
  const plant = getOwnedPlant(db, req.params.plantId, req.user.id)

  if (!plant) {
    return res.status(404).json({
      error: '植物不存在',
      code: 'PLANT_NOT_FOUND'
    })
  }

  const session = gardener.getOrCreateSession(db, plant.id, req.user.id, plant)
  const messages = gardener.listMessages(db, session.id)
  const pendingChanges = gardener.listPendingChanges(db, plant.id, 'pending')

  res.json({
    session: {
      id: session.id,
      summary: session.summary || '',
      greeting: session.greeting || gardener.buildGreeting(db, plant)
    },
    messages: messages.map(mapMessage),
    pending_changes: pendingChanges,
    plant: {
      id: plant.id,
      name: plant.name,
      species: plant.species,
      variety: plant.variety || '',
      location: plant.location || '',
      light_environment: plant.light_environment || ''
    }
  })
})

// 发送消息
router.post('/chat/gardener', async (req, res, next) => {
  try {
    const plantId = req.body && req.body.plant_id
    const message = String((req.body && req.body.message) || '').trim()

    if (!plantId || !message) {
      return res.status(400).json({
        error: 'plant_id 和 message 为必填项',
        code: 'MISSING_CHAT_FIELDS'
      })
    }

    const db = getDb()
    const plant = getOwnedPlant(db, plantId, req.user.id)

    if (!plant) {
      return res.status(404).json({
        error: '植物不存在',
        code: 'PLANT_NOT_FOUND'
      })
    }

    const session = gardener.getOrCreateSession(db, plant.id, req.user.id, plant)
    const history = gardener.listMessages(db, session.id)

    gardener.appendMessage(db, session, 'user', message)

    // 用户在对话里描述土壤状态（例如「现在土还是湿的」「刚浇过水」）就直接更新水分基准。
    // 以前这些输入不会影响任何数据，用户抱怨"说了也没用"（见 有待解决的问题.txt 第 2 组）。
    let waterNote = ''
    const waterState = waterBaseline.detectLevel(message)
    if (waterState) {
      try {
        const applied = await waterPlan.setWaterBaselineForPlant(plant.id, waterState.level, 'chat')
        if (applied.ok) {
          waterNote = '已把土壤水分更新成「' + waterState.label + '」，下次浇水日期重新算过了。'
        }
      } catch (err) {
        console.warn('[water] 按对话更新水分基准失败：' + err.message)
      }
    }

    const context = gardener.buildContext(db, plant, message)
    context.summary = session.summary || ''

    const result = await aiAdapter.gardenerChat(plant, context, history, message)

    gardener.appendMessage(db, session, 'assistant', result.reply)

    const saved = gardener.savePendingChanges(db, plant, session, result.proposed_changes)

    res.json({
      reply: result.reply,
      need_confirm: result.need_confirm,
      pending_changes: saved,
      skipped_changes: (result.proposed_changes || []).length - saved.length,
      water_note: waterNote
    })

    // 对话变长后压缩历史，不阻塞回复
    gardener.compressIfNeeded(db, session).catch((err) => {
      console.warn('[chat] 压缩会话失败：' + err.message)
    })
  } catch (err) {
    next(err)
  }
})

// 用户确认后执行变更
router.post('/chat/gardener/execute', (req, res, next) => {
  try {
    const plantId = req.body && req.body.plant_id
    const changeIds = (req.body && req.body.change_ids) || []

    if (!plantId || !Array.isArray(changeIds) || !changeIds.length) {
      return res.status(400).json({
        error: 'plant_id 和 change_ids 为必填项',
        code: 'MISSING_EXECUTE_FIELDS'
      })
    }

    const db = getDb()
    const plant = getOwnedPlant(db, plantId, req.user.id)

    if (!plant) {
      return res.status(404).json({
        error: '植物不存在',
        code: 'PLANT_NOT_FOUND'
      })
    }

    const applied = []
    const failed = []

    for (const changeId of changeIds) {
      const row = db
        .prepare("SELECT * FROM plant_pending_changes WHERE id = ? AND plant_id = ? AND status = 'pending'")
        .get(changeId, plant.id)

      if (!row) {
        failed.push({ id: changeId, error: '变更不存在或已处理' })
        continue
      }

      const change = gardener.mapPendingChange(row)

      try {
        const result = gardener.applyChange(db, plant, change)
        gardener.setPendingChangeStatus(db, change.id, 'applied')
        applied.push(result)
      } catch (err) {
        failed.push({ id: changeId, error: err.message })
      }
    }

    res.json({ applied, failed })
  } catch (err) {
    next(err)
  }
})

// 待确认变更列表
router.get('/plants/:id/pending-changes', (req, res) => {
  const db = getDb()
  const plant = getOwnedPlant(db, req.params.id, req.user.id)

  if (!plant) {
    return res.status(404).json({
      error: '植物不存在',
      code: 'PLANT_NOT_FOUND'
    })
  }

  const status = req.query.status
  res.json({ pending_changes: gardener.listPendingChanges(db, plant.id, status) })
})

function findPendingChange(db, plantId, changeId) {
  return db
    .prepare('SELECT * FROM plant_pending_changes WHERE id = ? AND plant_id = ?')
    .get(changeId, plantId)
}

router.post('/plants/:id/pending-changes/:changeId/apply', (req, res, next) => {
  try {
    const db = getDb()
    const plant = getOwnedPlant(db, req.params.id, req.user.id)
    const row = plant && findPendingChange(db, plant.id, req.params.changeId)

    if (!plant || !row) {
      return res.status(404).json({ error: '变更不存在', code: 'CHANGE_NOT_FOUND' })
    }

    if (row.status !== 'pending') {
      return res.status(400).json({ error: '该变更已经处理过了', code: 'CHANGE_ALREADY_HANDLED' })
    }

    const result = gardener.applyChange(db, plant, gardener.mapPendingChange(row))
    gardener.setPendingChangeStatus(db, row.id, 'applied')

    res.json({ applied: result })
  } catch (err) {
    next(err)
  }
})

router.post('/plants/:id/pending-changes/:changeId/reject', (req, res) => {
  const db = getDb()
  const plant = getOwnedPlant(db, req.params.id, req.user.id)
  const row = plant && findPendingChange(db, plant.id, req.params.changeId)

  if (!plant || !row) {
    return res.status(404).json({ error: '变更不存在', code: 'CHANGE_NOT_FOUND' })
  }

  gardener.setPendingChangeStatus(db, row.id, 'rejected')
  res.json({ rejected: true, change_id: row.id })
})

// 用户不满意当前方案：标记为修改中，等待 AI 重新澄清
router.post('/plants/:id/pending-changes/:changeId/revision', (req, res) => {
  const db = getDb()
  const plant = getOwnedPlant(db, req.params.id, req.user.id)
  const row = plant && findPendingChange(db, plant.id, req.params.changeId)

  if (!plant || !row) {
    return res.status(404).json({ error: '变更不存在', code: 'CHANGE_NOT_FOUND' })
  }

  const note = String((req.body && req.body.note) || '').slice(0, 200)

  gardener.setPendingChangeStatus(db, row.id, 'in_revision')
  res.json({ revision: true, change_id: row.id, note })
})

module.exports = router
