const { request, upload } = require('../../utils/request')
const { ICONS } = require('../../utils/icons')

Page({
  data: {
    icons: ICONS,
    id: '',
    name: '',
    species: '',
    variety: '',
    pot_size: '',
    soil_type: '',
    soil_id: '',
    exposure: '',
    pot_depth_mm: '',
    pot_diameter_mm: '',
    potDepthCm: '',
    potDiameterCm: '',
    location: '',
    light_environment: '',
    planting_date: '',
    growth_stage: '',
    plant_source: '',
    is_recent_transplant: 0,
    notes: '',
    image_url: '',
    image_path: '',
    speciesOptions: [],
    speciesIndex: -1,
    speciesGroupText: '',
    carePreview: null,
    manualSpecies: false,
    speciesQuery: '',
    speciesResults: [],
    soilOptions: [],
    soilIndex: -1,
    soilQuery: '',
    soilResults: [],
    potSpecOptions: [],
    potSpecIndex: -1,
    exposureOptions: [],
    exposureIndex: -1,
    growthStageOptions: ['播种苗', '小苗', '中苗', '大苗', '成株'],
    growthStageIndex: -1,
    plantSourceOptions: ['网购', '花市/花店', '自己播种', '扦插繁殖', '亲友赠送'],
    plantSourceIndex: -1,
    today: '',
    uploading: false
  },

  onLoad(options) {
    const now = new Date()
    const pad = (value) => (value < 10 ? '0' + value : '' + value)
    this.setData({
      today: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    })

    this.fetchSpeciesOptions()
    this.fetchPlantingOptions()

    if (options.id) {
      this.setData({ id: options.id })
      this.fetchPlant(options.id)
    }
  },

  fetchPlantingOptions() {
    request({ url: '/knowledge/planting-options' })
      .then((data) => {
        this.setData({
          soilOptions: data.soil_types || [],
          potSpecOptions: (data.pot_specs || []).map((item) => ({
            ...item,
            label: item.name + '（口径 ' + (item.diameter_mm / 10) + 'cm · 高 ' + (item.depth_mm / 10) + 'cm）'
          })),
          exposureOptions: data.exposures || []
        })
        this.syncPlantingIndexes()
      })
      .catch(() => {
        // 选项拉取失败时仍可手动填写
      })
  },

  syncPlantingIndexes() {
    const soilIndex = this.data.soilOptions.findIndex((item) =>
      item.id === this.data.soil_id || item.name === this.data.soil_type
    )
    const potIndex = this.data.potSpecOptions.findIndex((item) => item.name === this.data.pot_size)
    const exposureIndex = this.data.exposureOptions.findIndex((item) => item.id === this.data.exposure)

    this.setData({
      soilIndex,
      potSpecIndex: potIndex,
      exposureIndex
    })
  },

  onSoilChange(event) {
    const option = this.data.soilOptions[Number(event.detail.value)]
    if (!option) return
    this.setData({
      soilIndex: Number(event.detail.value),
      soil_id: option.id,
      soil_type: option.name,
      soilQuery: '',
      soilResults: []
    })
  },

  onSoilSearchInput(event) {
    const query = event.detail.value
    this.setData({
      soilQuery: query,
      soilResults: this.filterSoil(query)
    })
  },

  filterSoil(query) {
    const keyword = String(query || '').replace(/\s+/g, '').toLowerCase()
    if (!keyword) return []

    return this.data.soilOptions.filter((item) => {
      const fields = [item.name, item.id, ...(item.aliases || [])]
      return fields.some((field) => String(field || '').replace(/\s+/g, '').toLowerCase().includes(keyword))
    })
  },

  onPickSoil(event) {
    const id = event.currentTarget.dataset.id
    const index = this.data.soilOptions.findIndex((item) => item.id === id)
    if (index < 0) return
    const option = this.data.soilOptions[index]
    this.setData({
      soilIndex: index,
      soil_id: option.id,
      soil_type: option.name,
      soilQuery: '',
      soilResults: []
    })
  },

  onPotSpecChange(event) {
    const index = Number(event.detail.value)
    const option = this.data.potSpecOptions[index]
    if (!option) return
    this.setData({
      potSpecIndex: index,
      pot_size: option.name,
      pot_diameter_mm: option.diameter_mm,
      pot_depth_mm: option.depth_mm,
      potDiameterCm: option.diameter_mm / 10,
      potDepthCm: option.depth_mm / 10
    })
  },

  onClearSoilSearch() {
    this.setData({ soilQuery: '', soilResults: [] })
  },

  onExposureChange(event) {
    const index = Number(event.detail.value)
    const option = this.data.exposureOptions[index]
    if (!option) return
    this.setData({
      exposureIndex: index,
      exposure: option.id
    })
  },

  fetchSpeciesOptions() {
    request({ url: '/knowledge/species' })
      .then((data) => {
        const list = (data.species || []).map((item) => ({
          ...item,
          label: item.cn_name + '（' + item.care_group_label + '）'
        }))
        this.setData({ speciesOptions: list })
        this.syncSpeciesIndex()
      })
      .catch(() => {
        // 知识库拉取失败时仍可手动填写品种
      })
  },

  syncSpeciesIndex() {
    const species = this.data.species
    if (!species || !this.data.speciesOptions.length) return

    const index = this.data.speciesOptions.findIndex((item) => item.cn_name === species)
    if (index >= 0) {
      this.setData({
        speciesIndex: index,
        speciesGroupText: this.data.speciesOptions[index].care_group_label,
        manualSpecies: false
      })
      this.fetchCarePreview(this.data.speciesOptions[index].id)
      return
    }

    // 编辑已有植物时，知识库里没有这个品种就默认展开手动输入
    this.setData({
      speciesIndex: -1,
      speciesGroupText: '',
      carePreview: null,
      manualSpecies: true
    })
  },

  onToggleManualSpecies() {
    this.setData({ manualSpecies: !this.data.manualSpecies })
  },

  fetchCarePreview(speciesId) {
    request({ url: '/knowledge/species/' + encodeURIComponent(speciesId) })
      .then((data) => {
        const care = data.care || {}
        this.setData({
          carePreview: {
            watering: care.watering ? care.watering.interval_days : '—',
            fertilizing: care.fertilizing ? care.fertilizing.interval_days : '—',
            pesticide: care.pesticide ? care.pesticide.interval_days : '—',
            pruning: care.pruning ? care.pruning.interval_days : '—'
          }
        })
      })
      .catch(() => {
        this.setData({ carePreview: null })
      })
  },

  onSpeciesChange(event) {
    const index = Number(event.detail.value)
    this.applySpecies(index)
  },

  applySpecies(index) {
    const option = this.data.speciesOptions[index]
    if (!option) return

    this.setData({
      species: option.cn_name,
      speciesIndex: index,
      speciesGroupText: option.care_group_label,
      manualSpecies: false,
      speciesQuery: '',
      speciesResults: []
    })
    this.fetchCarePreview(option.id)
  },

  onSearchInput(event) {
    const query = event.detail.value
    this.setData({
      speciesQuery: query,
      speciesResults: this.filterSpecies(query)
    })
  },

  filterSpecies(query) {
    const keyword = String(query || '').trim().toLowerCase()
    if (!keyword) return []

    return this.data.speciesOptions
      .filter((item) => {
        const fields = [
          item.cn_name,
          item.scientific_name,
          item.care_group_label,
          ...(item.aliases || [])
        ].filter(Boolean)

        return fields.some((field) => String(field).toLowerCase().includes(keyword))
      })
      .slice(0, 20)
  },

  onPickSpecies(event) {
    const id = event.currentTarget.dataset.id
    const index = this.data.speciesOptions.findIndex((item) => item.id === id)
    if (index >= 0) this.applySpecies(index)
  },

  onClearSearch() {
    this.setData({ speciesQuery: '', speciesResults: [] })
  },

  goCareGuide(event) {
    const section = event.currentTarget.dataset.section || 'pot_size'
    wx.navigateTo({
      url: '/pages/care-guide/care-guide?section=' + section
    })
  },

  fetchPlant(id) {
    request({ url: '/plants/' + id })
      .then((data) => {
        const plant = data.plant || {}
        this.setData({
          name: plant.name || '',
          species: plant.species || '',
          variety: plant.variety || '',
          pot_size: plant.pot_size || '',
          soil_type: plant.soil_type || '',
          location: plant.location || '',
          light_environment: plant.light_environment || '',
          planting_date: plant.planting_date || '',
          soil_id: plant.soil_id || '',
          exposure: plant.exposure || '',
          pot_depth_mm: plant.pot_depth_mm || '',
          pot_diameter_mm: plant.pot_diameter_mm || '',
          potDepthCm: plant.pot_depth_mm ? plant.pot_depth_mm / 10 : '',
          potDiameterCm: plant.pot_diameter_mm ? plant.pot_diameter_mm / 10 : '',
          growth_stage: plant.growth_stage || '',
          plant_source: plant.plant_source || '',
          is_recent_transplant: Number(plant.is_recent_transplant) ? 1 : 0,
          notes: plant.notes || '',
          image_url: plant.image_url || ''
        })
        this.setData({
          growthStageIndex: this.data.growthStageOptions.indexOf(plant.growth_stage || ''),
          plantSourceIndex: this.data.plantSourceOptions.indexOf(plant.plant_source || '')
        })
        this.syncPlantingIndexes()
        this.syncSpeciesIndex()
      })
      .catch((err) => {
        wx.showToast({
          title: err.message || '获取植物失败',
          icon: 'none'
        })
      })
  },

  onInput(event) {
    const field = event.currentTarget.dataset.field
    const value = event.detail.value

    // 口径与盆高按厘米手填，内部换算成毫米给天气系数模型使用
    if (field === 'potDiameterCm') {
      this.setData({
        potDiameterCm: value,
        pot_diameter_mm: value ? Math.round(Number(value) * 10) : ''
      })
      return
    }

    if (field === 'potDepthCm') {
      this.setData({
        potDepthCm: value,
        pot_depth_mm: value ? Math.round(Number(value) * 10) : ''
      })
      return
    }

    this.setData({ [field]: value })
  },

  onDateChange(event) {
    this.setData({ planting_date: event.detail.value })
  },

  // 开始养护日期是选填项：入手时间不明时允许清空，不填也能保存
  onClearDate() {
    this.setData({ planting_date: '' })
  },

  onGrowthStageChange(event) {
    const index = Number(event.detail.value)
    this.setData({
      growthStageIndex: index,
      growth_stage: this.data.growthStageOptions[index] || ''
    })
  },

  onPlantSourceChange(event) {
    const index = Number(event.detail.value)
    this.setData({
      plantSourceIndex: index,
      plant_source: this.data.plantSourceOptions[index] || ''
    })
  },

  onTransplantChange(event) {
    this.setData({ is_recent_transplant: event.detail.value ? 1 : 0 })
  },

  onChooseImage() {
    if (this.data.uploading) return

    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const filePath = res.tempFiles && res.tempFiles[0] && res.tempFiles[0].tempFilePath
        if (filePath) {
          this.uploadPlantImage(filePath)
        }
      }
    })
  },

  uploadPlantImage(filePath) {
    this.setData({ uploading: true })

    upload({
      url: '/storage',
      filePath,
      name: 'file',
      formData: {
        category: 'plants'
      }
    })
      .then((data) => {
        this.setData({
          image_url: data.url || '',
          image_path: data.relative_path || '',
          uploading: false
        })
      })
      .catch((err) => {
        this.setData({ uploading: false })
        wx.showToast({
          title: err.message || '图片上传失败',
          icon: 'none'
        })
      })
  },

  onSubmit() {
    const { id, name, species, growth_stage } = this.data
    if (!name || !species) {
      wx.showToast({
        title: '请填写植物名称和品种',
        icon: 'none'
      })
      return
    }

    if (!growth_stage) {
      wx.showToast({
        title: '请选择苗情阶段',
        icon: 'none'
      })
      return
    }

    if (!this.data.exposure) {
      wx.showToast({
        title: '请选择摆放环境',
        icon: 'none'
      })
      return
    }

    const payload = {
      name,
      species,
      variety: this.data.variety || '',
      pot_size: this.data.pot_size,
      soil_type: this.data.soil_type,
      soil_id: this.data.soil_id,
      exposure: this.data.exposure,
      pot_depth_mm: Number(this.data.pot_depth_mm) || 0,
      pot_diameter_mm: Number(this.data.pot_diameter_mm) || 0,
      location: this.data.location,
      light_environment: this.data.light_environment,
      planting_date: this.data.planting_date,
      growth_stage: this.data.growth_stage,
      plant_source: this.data.plant_source,
      is_recent_transplant: this.data.is_recent_transplant,
      notes: this.data.notes,
      // 优先提交相对路径，后端会统一保存成与域名无关的路径
      image_url: this.data.image_path || this.data.image_url
    }

    const req = id
      ? request({ url: '/plants/' + id, method: 'PUT', data: payload })
      : request({ url: '/plants', method: 'POST', data: payload })

    req
      .then((data) => {
        wx.showToast({
          title: id ? '保存成功' : '添加成功',
          icon: 'success'
        })

        setTimeout(() => {
          wx.navigateBack({
            fail() {
              wx.switchTab({ url: '/pages/garden/garden' })
            }
          })
        }, 600)
      })
      .catch((err) => {
        wx.showModal({
          title: '保存失败',
          content: err.message || '请确认后端服务已启动',
          showCancel: false
        })
      })
  }
})
