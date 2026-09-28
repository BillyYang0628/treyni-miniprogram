/**
 * 换盆确认面板（第四期）。
 *
 * 换盆是"事件型"：一次性、没有周期、不会被 AI 排下一轮。
 * 完成后要做三件事，所以不能套用普通的完成登记面板：
 *   1. 更新花盆和土壤（**这两个字段直接喂天气水分模型**）
 *   2. 记下换盆日 → 触发 14 天缓苗期（这段时间不施肥）
 *   3. 让服务端立刻按新花盆重算浇水
 *
 * 「先不填也行」这个选项必须留着——孩子未必知道家里那个盆是几加仑，
 * 但提示要把代价说清楚（按《措辞规范》第 5 条：说清代价，而不是含糊地"建议"）。
 *
 * 选项直接复用 /knowledge/planting-options，和添加植物页是同一套。
 */
const { request } = require('../../utils/request')

Component({
  properties: {
    show: {
      type: Boolean,
      value: false
    },
    reminder: {
      type: Object,
      value: null
    },
    plant: {
      type: Object,
      value: null
    }
  },

  data: {
    loading: false,
    saving: false,
    potOptions: [],
    soilOptions: [],
    potIndex: -1,
    soilIndex: -1,
    potLabel: '还没选',
    soilLabel: '还没选'
  },

  observers: {
    show: function (show) {
      if (show) this.prepare()
    }
  },

  methods: {
    prepare() {
      const plant = this.data.plant || {}
      this.setData({ saving: false })

      request({ url: '/knowledge/planting-options' })
        .then((data) => {
          const potOptions = (data.pot_specs || []).map((item) => ({
            ...item,
            label: item.name + '（口径 ' + (item.diameter_mm / 10) + 'cm · 高 ' + (item.depth_mm / 10) + 'cm）'
          }))
          const soilOptions = (data.soil_types || [])

          const potIndex = potOptions.findIndex((item) => item.name === plant.pot_size)
          const soilIndex = soilOptions.findIndex((item) =>
            item.id === plant.soil_id || item.name === plant.soil_type)

          this.setData({
            potOptions,
            soilOptions,
            potIndex,
            soilIndex,
            potLabel: potIndex >= 0 ? potOptions[potIndex].label : '还没选',
            soilLabel: soilIndex >= 0 ? soilOptions[soilIndex].name : '还没选'
          })
        })
        .catch(() => {
          // 选项拉不到也允许"先不填"直接提交
        })
    },

    onPotChange(event) {
      const index = Number(event.detail.value)
      const option = this.data.potOptions[index]
      this.setData({ potIndex: index, potLabel: option ? option.label : '还没选' })
    },

    onSoilChange(event) {
      const index = Number(event.detail.value)
      const option = this.data.soilOptions[index]
      this.setData({ soilIndex: index, soilLabel: option ? option.name : '还没选' })
    },

    onCancel() {
      this.triggerEvent('cancel')
    },

    /** 什么都不填，只记"换了盆" */
    onSkip() {
      if (this.data.saving) return
      this.setData({ saving: true })
      this.triggerEvent('submit', { skip_profile: true })
    },

    onSubmit() {
      if (this.data.saving) return
      const { potOptions, soilOptions, potIndex, soilIndex } = this.data
      const payload = {}

      if (potIndex >= 0 && potOptions[potIndex]) {
        const pot = potOptions[potIndex]
        payload.pot_size = pot.name
        payload.pot_depth_mm = pot.depth_mm
        payload.pot_diameter_mm = pot.diameter_mm
      }
      if (soilIndex >= 0 && soilOptions[soilIndex]) {
        const soil = soilOptions[soilIndex]
        payload.soil_type = soil.name
        payload.soil_id = soil.id
      }

      if (!payload.pot_size && !payload.soil_type) {
        this.onSkip()
        return
      }

      this.setData({ saving: true })
      this.triggerEvent('submit', payload)
    }
  }
})
