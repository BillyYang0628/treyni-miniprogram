const express = require('express')
const knowledge = require('../services/knowledge')
const waterModel = require('../services/waterModel')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()

router.use(requireAuth)

// 种植条件选项：土壤类型、花盆规格、摆放环境（供添加植物页使用）
router.get('/planting-options', (req, res) => {
  res.json({
    soil_types: waterModel.getSoils().map((item) => ({
      id: item.id,
      name: item.name,
      w: item.w,
      drainage: item.drainage,
      aliases: item.aliases || []
    })),
    pot_specs: waterModel.getPotSpecs(),
    exposures: waterModel.getExposures()
  })
})

// 品种目录，供小程序添加植物时选择品种
router.get('/species', (req, res) => {
  const plants = knowledge.loadPlants()

  const species = Object.entries(plants)
    .map(([id, item]) => ({
      id,
      cn_name: item.cn_name,
      scientific_name: item.scientific_name,
      care_group: item.care_group,
      care_group_label: item.care_group_label,
      difficulty: item.difficulty || '',
      scene: item.scene || [],
      aliases: item.aliases || []
    }))
    .sort((a, b) => (plants[a.id].index || 0) - (plants[b.id].index || 0))

  res.json({
    species,
    stats: knowledge.getStats()
  })
})

// 单个品种的养护节奏，供添加植物时预览
router.get('/species/:id', (req, res) => {
  const found = knowledge.findSpecies(req.params.id)

  if (!found) {
    return res.status(404).json({
      error: '知识库里没有这个品种',
      code: 'SPECIES_NOT_FOUND'
    })
  }

  const care = {}
  for (const type of ['watering', 'fertilizing', 'pesticide', 'pruning']) {
    const rule = knowledge.getCareRule(found.id, type)
    care[type] = rule
      ? {
          interval_days: rule.interval_days,
          note: rule.note,
          library: rule.library,
          library_label: rule.libraryLabel
        }
      : null
  }

  res.json({
    species: {
      id: found.id,
      ...found.entry
    },
    care,
    environment: knowledge.getEnvironment(found.id)
  })
})

module.exports = router
