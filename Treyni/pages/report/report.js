const { request } = require('../../utils/request')
const util = require('../../utils/util')
const { ICONS } = require('../../utils/icons')

const STAT_ITEMS = [
  { key: 'care_days', label: '养护天数', suffix: ' 天', icon: ICONS.season },
  { key: 'journal_total', label: '养护记录', suffix: ' 条', icon: ICONS.reportRecords },
  { key: 'reminder_completed', label: '完成提醒', suffix: ' 次', icon: ICONS.bell },
  { key: 'on_time_rate', label: '按期完成', suffix: '%', icon: ICONS.done },
  { key: 'diagnosis_count', label: 'AI 诊断', suffix: ' 次', icon: ICONS.aiDiagnosis },
  { key: 'treatment_count', label: '用药处理', suffix: ' 次', icon: ICONS.pesticide }
]

function buildStats(stats) {
  if (!stats) return []
  return STAT_ITEMS
    .filter((item) => stats[item.key] !== undefined && stats[item.key] !== null)
    .map((item) => ({
      icon: item.icon,
      label: item.label,
      value: stats[item.key] + item.suffix
    }))
}

Page({
  data: {
    icons: ICONS,
    plantId: '',
    plantName: '',
    loading: true,
    generating: false,
    elapsed: 0,
    estimateText: '',
    error: '',
    requestId: null,
    report: null,
    stats: [],
    history: [],
    generatedText: ''
  },

  onLoad(options) {
    this.setData({ plantId: options.plant_id || '' })
    this.fetchPlant()
    this.fetchHistory()
  },

  onUnload() {
    this.stopTimer()
    this.stopPolling()
  },

  fetchPlant() {
    if (!this.data.plantId) return
    request({ url: '/plants/' + this.data.plantId })
      .then((data) => {
        const plant = data.plant || {}
        this.setData({
          plantName: plant.name || plant.species || '这盆植物',
          loading: false
        })
        wx.setNavigationBarTitle({ title: (plant.name || '植物') + ' · 养护报告' })
      })
      .catch(() => this.setData({ loading: false }))
  },

  fetchHistory() {
    if (!this.data.plantId) return
    request({ url: '/plants/' + this.data.plantId + '/reports' })
      .then((data) => {
        const reports = data.reports || []
        this.setData({
          history: reports.map((item) => ({
            id: item.id,
            title: item.title,
            period: item.period_text,
            timeText: util.formatDateTime(item.generated_at)
          }))
        })

        if (reports.length && !this.data.report) {
          this.showReport(reports[0])
        }
      })
      .catch(() => {})
  },

  showReport(report) {
    this.setData({
      report,
      stats: buildStats(report.stats),
      generatedText: util.formatDateTime(report.generated_at),
      error: ''
    })
  },

  onPickHistory(event) {
    const id = event.currentTarget.dataset.id
    request({ url: '/reports/' + id })
      .then((data) => {
        if (data.report) this.showReport(data.report)
      })
      .catch((err) => wx.showToast({ title: err.message || '打开失败', icon: 'none' }))
  },

  onGenerate() {
    if (this.data.generating) return

    this.setData({
      generating: true,
      error: '',
      estimateText: '预计 10-40 秒，请保持页面打开',
      elapsed: 0
    })
    this.startTimer()

    request({
      url: '/plants/' + this.data.plantId + '/report',
      method: 'POST',
      timeout: 30000,
      data: {}
    })
      .then((data) => {
        this.setData({ requestId: data.request_id })
        this.startPolling(data.request_id)
      })
      .catch((err) => {
        this.stopTimer()
        this.setData({
          generating: false,
          estimateText: '',
            error: err.detail || err.message || '创建报告失败，请重试'
        })
      })
  },

  startPolling(requestId) {
    this.stopPolling()

    this.poller = setInterval(() => {
      request({ url: '/report-requests/' + requestId })
        .then((data) => {
          const status = data.request && data.request.status

          if (status === 'completed' && data.report) {
            this.stopPolling()
            this.stopTimer()
            this.setData({
              generating: false,
              estimateText: '',
              elapsed: 0,
              requestId: null
            })
            this.showReport(data.report)
            this.fetchHistory()
            wx.showToast({ title: '报告已生成', icon: 'success' })
            return
          }

          if (status === 'failed') {
            this.stopPolling()
            this.stopTimer()
            this.setData({
              generating: false,
              estimateText: '',
              requestId: null,
              error: (data.request && data.request.error_info) || '报告生成失败，请重试'
            })
          }
        })
        .catch(() => {
          // 单次轮询失败不打断整体流程
        })
    }, 5000)
  },

  stopPolling() {
    if (this.poller) {
      clearInterval(this.poller)
      this.poller = null
    }
  },

  startTimer() {
    this.stopTimer()
    this.timer = setInterval(() => {
      this.setData({ elapsed: this.data.elapsed + 1 })
    }, 1000)
  },

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  },

  goBack() {
    wx.navigateBack({
      fail() {
        wx.switchTab({ url: '/pages/garden/garden' })
      }
    })
  }
})
