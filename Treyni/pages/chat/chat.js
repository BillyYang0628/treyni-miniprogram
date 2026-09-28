const { request } = require('../../utils/request')
const util = require('../../utils/util')
const { ICONS } = require('../../utils/icons')

// 生成过程中的五个阶段各配一张像素图标，和文案一一对应
const STAGE_ICONS = [ICONS.judge, ICONS.guide, ICONS.fertilizing, ICONS.leaf, ICONS.chatWrite]

function formatChange(item) {
  const fields = item.fields || {}
  const label = item.label || fields.label || ''

  if (item.change_type === 'reminder') {
    const names = { watering: '浇水', fertilizing: '施肥', pesticide: '打药', pruning: '修剪' }
    return {
      ...item,
      title: '调整提醒',
      text: label || `把${names[fields.reminder_type] || '养护'}改成每 ${fields.interval_days} 天一次`
    }
  }

  return {
    ...item,
    title: '修改档案',
    text: label || `把${fields.field}改成${fields.value}`
  }
}

Page({
  data: {
    icons: ICONS,
    plantId: '',
    plant: null,
    messages: [],
    greeting: '',
    pendingChanges: [],
    input: '',
    loading: true,
    sending: false,
    estimateText: '',
    elapsed: 0,
    error: '',
    resolving: '',
    scrollTarget: '',
    stageText: '',
    stageIcon: ICONS.leaf,
    stageIndex: 0
  },

  onLoad(options) {
    this.setData({ plantId: options.plant_id || '' })
    this.fetchSession()
  },

  onUnload() {
    this.stopTimer()
  },

  startTimer(stages) {
    this.stopTimer()
    const list = stages && stages.length ? stages : ['托蕾妮正在想…']
    this.stages = list
    this.setData({
      elapsed: 0,
      stageIndex: 0,
      stageText: list[0],
      stageIcon: STAGE_ICONS[0] || ICONS.leaf
    })

    this.timer = setInterval(() => {
      const elapsed = this.data.elapsed + 1
      const index = Math.min(list.length - 1, Math.floor(elapsed / 6))
      this.setData({
        elapsed,
        stageIndex: index,
        stageText: list[index],
        stageIcon: STAGE_ICONS[index] || ICONS.leaf
      })
    }, 1000)
  },

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  },

  fetchSession() {
    if (!this.data.plantId) return

    request({ url: '/chat/gardener/session/' + this.data.plantId })
      .then((data) => {
        this.setData({
          plant: data.plant,
          greeting: data.session.greeting || '',
          messages: (data.messages || []).map((item) => ({
            ...item,
            timeText: util.formatDateTime(item.created_at)
          })),
          pendingChanges: (data.pending_changes || []).map(formatChange),
          loading: false
        })
        this.scrollToBottom()
      })
      .catch((err) => {
        this.setData({ loading: false })
        wx.showModal({
          title: '打开失败',
          content: err.message || '暂时无法进入对话',
          showCancel: false,
          success: () => wx.navigateBack()
        })
      })
  },

  onInput(event) {
    this.setData({ input: event.detail.value })
  },

  // 新消息进来后滚到底部
  scrollToBottom() {
    this.setData({ scrollTarget: '' })
    setTimeout(() => {
      this.setData({ scrollTarget: 'chat-bottom' })
    }, 60)
  },

  onUseSample(event) {
    this.setData({ input: event.currentTarget.dataset.text })
  },

  onSend() {
    const message = (this.data.input || '').trim()
    if (!message || this.data.sending) return

    const now = new Date().toISOString()
    this.setData({
      sending: true,
      error: '',
      input: '',
      estimateText: '预计 10-40 秒，请稍等',
      messages: this.data.messages.concat([{
        role: 'user',
        content: message,
        timeText: util.formatDateTime(now)
      }])
    })
    const species = (this.data.plant && this.data.plant.species) || '植物'
    this.startTimer([
      `正在翻看这盆${species}的档案…`,
      '正在查这个品种的养护知识…',
      '正在核对用药与施肥方案…',
      '正在想适合它现在状态的做法…',
      '正在把建议整理成话…'
    ])
    this.scrollToBottom()

    request({
      url: '/chat/gardener',
      method: 'POST',
      timeout: 300000,
      data: { plant_id: this.data.plantId, message }
    })
      .then((data) => {
        this.stopTimer()
        const added = (data.pending_changes || []).map(formatChange)
        const now = util.formatDateTime(new Date().toISOString())

        // 用户在对话里描述了土壤状态时，后端会直接更新水分基准并回一条说明。
        // 用 system 气泡如实展示——改了数据就要让用户看得见。
        const extra = data.water_note
          ? [{ role: 'system', content: data.water_note, timeText: now }]
          : []

        this.setData({
          sending: false,
          estimateText: '',
          elapsed: 0,
          messages: this.data.messages.concat([{
            role: 'assistant',
            content: data.reply,
            timeText: now
          }]).concat(extra),
          pendingChanges: this.data.pendingChanges.concat(added),
          stageText: ''
        })
        this.scrollToBottom()
      })
      .catch((err) => {
        this.stopTimer()
        this.setData({
          sending: false,
          estimateText: '',
          elapsed: 0,
          stageText: '',
          error: err.detail || err.message || '托蕾妮没有回应，请重试'
        })
      })
  },

  onRetry() {
    this.setData({ error: '' })
  },

  onConfirmChange(event) {
    const id = event.currentTarget.dataset.id
    if (this.data.resolving) return
    this.setData({ resolving: id })

    request({
      url: '/chat/gardener/execute',
      method: 'POST',
      data: { plant_id: this.data.plantId, change_ids: [id] }
    })
      .then((data) => {
        const applied = (data.applied || [])[0]
        const failed = (data.failed || [])[0]

        if (failed) {
          wx.showToast({ title: failed.error || '执行失败', icon: 'none' })
        } else {
          wx.showToast({ title: '已按你说的调整', icon: 'success' })
        }

        this.setData({
          resolving: '',
          pendingChanges: this.data.pendingChanges.filter((item) => item.id !== id),
          messages: this.data.messages.concat([{
            role: 'system',
            content: applied ? '已执行：' + applied.label : '这项变更没有执行成功',
            timeText: util.formatDateTime(new Date().toISOString())
          }])
        })
        this.scrollToBottom()
      })
      .catch((err) => {
        this.setData({ resolving: '' })
        wx.showToast({ title: err.message || '执行失败', icon: 'none' })
      })
  },

  onRejectChange(event) {
    const id = event.currentTarget.dataset.id
    this.setData({ resolving: id })

    request({
      url: '/plants/' + this.data.plantId + '/pending-changes/' + id + '/reject',
      method: 'POST'
    })
      .then(() => {
        this.setData({
          resolving: '',
          pendingChanges: this.data.pendingChanges.filter((item) => item.id !== id)
        })
        wx.showToast({ title: '那就不改', icon: 'none' })
      })
      .catch((err) => {
        this.setData({ resolving: '' })
        wx.showToast({ title: err.message || '操作失败', icon: 'none' })
      })
  },

  onEndChat() {
    if (!this.data.pendingChanges.length) {
      this.goBack()
      return
    }

    wx.showModal({
      title: '还有变更没确认',
      content: '刚才提到的调整还没处理，要现在确认吗？',
      confirmText: '现在处理',
      cancelText: '先不改',
      success: (res) => {
        if (res.confirm) {
          this.scrollToBottom()
          return
        }

        const ids = this.data.pendingChanges.map((item) => item.id)
        Promise.all(ids.map((id) => request({
          url: '/plants/' + this.data.plantId + '/pending-changes/' + id + '/reject',
          method: 'POST'
        }).catch(() => null))).then(() => {
          this.setData({ pendingChanges: [] })
          this.goBack()
        })
      }
    })
  },

  goBack() {
    wx.navigateBack({
      fail() {
        wx.switchTab({ url: '/pages/garden/garden' })
      }
    })
  }
})
