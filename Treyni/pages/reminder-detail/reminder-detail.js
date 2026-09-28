const { request } = require('../../utils/request')
const util = require('../../utils/util')
const { ICONS, TYPE_ICONS } = require('../../utils/icons')
const { overdueColor } = require('../../utils/overdue')

const AI_DETAIL_TYPES = ['watering', 'fertilizing', 'pesticide', 'pruning']

const DETAIL_SOURCE_TEXT = {
  water_model: '按当地天气推算',
  daily_care: '内容来自 植物日常养护库',
  fertilizing: '内容来自 施肥库',
  pesticide: '内容来自 病虫害用药库',
  ai: 'AI 已结合这盆植物生成'
}

// 详情内容按条拆开，配上图标，方便一眼看清哪一条在讲什么
const ICON_RULES = [
  { icon: ICONS.pitfall, test: /别踩坑|误区|常见错误|禁忌|安全|慎用|不推荐|不要|切记|特别注意|注意/ },
  { icon: ICONS.season, test: /季节|节奏|频率|多久|间隔|天数|休眠|越冬|越夏|复查|什么时候/ },
  { icon: ICONS.judge, test: /判断|怎么看|要不要|识别|信号|检查|观察/ },
  { icon: ICONS.fertilizing, test: /用什么|肥料|药剂|稀释|配比|浓度|\d+\s*倍|药/ },
  { icon: ICONS.pest, test: /防什么|防治|病虫害|病|虫/ },
  { icon: ICONS.operate, test: /操作|怎么做|浇|喷|剪|施肥|换盆/ }
]

function pickIcon(text) {
  const rule = ICON_RULES.find((item) => item.test.test(text))
  return rule ? rule.icon : ICONS.pushpin
}

// 让用户自己描述当前土壤状态的选项（和服务端 waterBaseline.LEVELS 的 key 对应）
const WATER_LEVELS = [
  { key: 'soaked', label: '刚浇过水' },
  { key: 'wet', label: '还有点湿' },
  { key: 'half', label: '半干' },
  { key: 'dry', label: '已经干透' }
]

/**
 * 土壤水分展示要用的两个派生值。
 *
 * 为什么需要：水分模型的推演起点以前固定是「今天刚浇透」，跟实际什么时候浇的水无关。
 * 现在有用户确认过的基准（water.baseline）才敢显示"现在还剩多少"，
 * 没有基准时页面要主动问一次，而不是拿一个默认值糊弄。
 */
function waterDerived(water) {
  if (!water) return { needsWaterBaseline: false, waterBaselineText: '' }

  const baseline = water.baseline
  let text = ''

  if (baseline && water.from_baseline) {
    const matched = String(baseline.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
    const day = matched ? Number(matched[2]) + '月' + Number(matched[3]) + '日' : baseline.date
    text = day + '你说土壤「' + baseline.label + '」，之后每天消耗约 ' +
      water.baseline_daily_use + '%，现在还剩约 ' + water.tank_percent + '%'
  }

  return {
    needsWaterBaseline: !baseline,
    waterBaselineText: text
  }
}

function buildDetailItems(text) {
  const raw = String(text || '').trim()
  if (!raw) return []

  let parts = raw
    .split(/(?=[①②③④⑤⑥⑦⑧⑨⑩])/)
    .map((item) => item.trim())
    .filter(Boolean)

  if (parts.length <= 1) {
    parts = raw
      .split(/(?=(?:^|\n)\s*\d+[)）])/)
      .map((item) => item.trim())
      .filter(Boolean)
  }

  if (parts.length <= 1) return []

  return parts.map((item) => ({ text: item, icon: pickIcon(item) }))
}

function reminderLine(label, reminder) {
  if (!reminder) return null
  const when = [reminder.due_label, reminder.due_text].filter(Boolean).join(' ')
  return {
    key: label + '_' + reminder.id,
    label: label,
    title: reminder.title,
    when
  }
}

Page({
  data: {
    icons: ICONS,
    sheetShow: false,
    repotShow: false,
    undoShow: false,
    undoSeconds: 5,
    undoToken: '',
    id: '',
    loading: true,
    reminder: null,
    plant: null,
    related: null,
    typeText: '',
    lateDays: 0,
    overdueColor: '',
    summary: '',
    detailText: '',
    detailItems: [],
    detailSourceText: '',
    aiStatus: '',
    aiError: '',
    aiReason: '',
    water: null,
    waterPercentText: '',
    waterEt0Text: '',
    waterResetText: '',
    waterCorrectText: '',
    // 土壤水分基准：没有就让用户先确认一次
    baselineLevels: WATER_LEVELS,
    needsWaterBaseline: false,
    waterBaselineText: '',
    savingBaseline: false,
    restText: '',
    noticeText: '',
    regeneratingAdvice: false,
    statusText: '',
    canGenerate: false,
    generateButtonText: '生成详细方案',
    generating: false,
    estimateText: '',
    elapsed: 0,
    error: '',

    // 用药效果询问
    isFeedback: false,
    feedbackRound: 1,
    stage: 'ask',
    resultTitle: '',
    resultText: '',
    nextReminders: [],
    consulting: false,
    consultError: '',
    suggestion: ''
  },

  onLoad(options) {
    this.setData({ id: options.id || '' })
    this.enableShareMenus()
    this.fetchReminder()
  },

  /** 转发单条方案（可选那条）。和另外两个页面一样，没有它右上角转发是灰的 */
  onShareAppMessage() {
    const reminder = this.data.reminder || {}
    return {
      title: reminder.title ? ('托蕾妮 · ' + reminder.title) : '托蕾妮 · 植物养护助手',
      path: '/pages/reminder-detail/reminder-detail?id=' + this.data.id,
      imageUrl: '/assets/brand/share-cover.png'
    }
  },

  /** 分享到朋友圈：字段是 query 不是 path，且不带前导 ?（落到当前页面 + 这串参数） */
  onShareTimeline() {
    const reminder = this.data.reminder || {}
    return {
      title: reminder.title ? ('托蕾妮 · ' + reminder.title) : '托蕾妮 · 植物养护助手',
      query: 'id=' + this.data.id,
      imageUrl: '/assets/brand/share-cover.png'
    }
  },

  enableShareMenus() {
    if (typeof wx.showShareMenu !== 'function') return
    wx.showShareMenu({
      menus: ['shareAppMessage', 'shareTimeline'],
      fail: (err) => console.warn('[share] showShareMenu 失败：' + (err && err.errMsg))
    })
  },

  onUnload() {
    this.stopTimer()
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
  },

  /**
   * 页内提示：成功类反馈改成页面上方的一条窄提示，不再用居中的 wx.showToast
   * （居中 toast 会盖住下面的卡片文字，用户反馈过）。
   */
  showNotice(text, duration = 2600) {
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.setData({ noticeText: text })
    this.noticeTimer = setTimeout(() => {
      this.setData({ noticeText: '' })
      this.noticeTimer = null
    }, duration)
  },

  startTimer() {
    this.stopTimer()
    this.setData({ elapsed: 0 })
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

  fetchReminder() {
    if (!this.data.id) return

    request({ url: '/reminders/' + this.data.id })
      .then((data) => {
        const reminder = data.reminder || {}
        const canGenerate = AI_DETAIL_TYPES.indexOf(reminder.type) >= 0
        const isFeedback = reminder.type === 'treatment_feedback'

        this.setData({
          reminder,
          plant: data.plant || null,
          related: data.related_reminder || null,
          typeText: util.REMINDER_TYPE_TEXT[reminder.type] || '养护提醒',
          typeIcon: TYPE_ICONS[reminder.type] || ICONS.leaf,
          lateDays: Number(reminder.late_days) || 0,
          overdueColor: overdueColor(reminder.late_days),
          summary: reminder.summary_text || reminder.title || '',
          detailText: reminder.detail_content || reminder.content || '',
          detailItems: buildDetailItems(reminder.detail_content || reminder.content || ''),
          detailSourceText: DETAIL_SOURCE_TEXT[reminder.detail_source] || '',
          aiStatus: reminder.ai_status || '',
          aiError: reminder.ai_error || '',
          aiReason: reminder.ai_reason || '',
          water: reminder.water || null,
          waterPercentText: reminder.water ? reminder.water.tank_percent + '%' : '',
          waterEt0Text: reminder.water && reminder.water.et0
            ? '约 ' + reminder.water.et0 + ' mm/天'
            : '',
          waterResetText: reminder.water && reminder.water.rain_reset_days && reminder.water.rain_reset_days.length
            ? reminder.water.rain_reset_days.join('、') + ' 下过雨，相当于浇了一次水，日期已重置'
            : '',
          ...waterDerived(reminder.water),
          // 天气模型与知识库差得太多时，说明折中后的结果，避免用户看到两套数字
          waterCorrectText: reminder.water && reminder.water.corrected
            ? '天气模型算出每 ' + reminder.water.model_interval_days + ' 天一次，知识库标准是每 ' +
              reminder.water.knowledge_interval_days + ' 天，已折中成每 ' + reminder.water.interval_days +
              ' 天一次（更偏向当地天气）'
            : '',
          restText: reminder.meta && reminder.meta.rest === 'transplant'
            ? '缓苗期：刚换盆或刚移栽，这期间先不施肥'
            : '',
          generateButtonText: reminder.has_detail
            ? '重新生成这份方案'
            : '生成详细方案',
          statusText: reminder.status === 'completed'
            ? '已完成' + (reminder.completed_at ? ' · ' + util.formatDateTime(reminder.completed_at) : '')
            : (reminder.due_label || '') + (reminder.due_text ? ' · ' + reminder.due_text : ''),
          canGenerate,
          isFeedback,
          feedbackRound: Number(reminder.treatment_round || 1),
          loading: false
        })

        // 已经提交过的反馈不再重复询问
        if (isFeedback && reminder.status === 'completed') {
          this.setData({
            stage: 'result',
            resultTitle: '这条反馈已经提交过了',
            resultText: '你的用药反馈已经记录在植物养护历程里。' +
              '如果想回看当时的喷药方案，可以返回植物详情页，点开对应的喷药提醒。',
            nextReminders: []
          })
          return
        }

        // 浇水、施肥、修剪第一次打开时自动生成详细方案
        if (canGenerate && !reminder.has_detail) {
          this.generateDetail(false)
        }
      })
      .catch((err) => {
        this.setData({ loading: false })
        wx.showModal({
          title: '打开失败',
          content: err.message || '这条提醒可能已经被删除',
          showCancel: false,
          success: () => wx.navigateBack()
        })
      })
  },

  generateDetail(force, feedback) {
    if (this.data.generating) return

    this.setData({
      generating: true,
      error: '',
      estimateText: force
        ? '正在按你说的重新生成，预计 10-40 秒'
        : '正在按这盆植物的档案生成方案，预计 10-40 秒'
    })
    this.startTimer()

    request({
      url: '/reminders/' + this.data.id + '/detail',
      method: 'POST',
      timeout: 300000,
      data: { force: Boolean(force), feedback: feedback || '' }
    })
      .then((data) => {
        this.stopTimer()
        const reminder = data.reminder || {}
        const detailText = reminder.detail_content || reminder.content || ''

        this.setData({
          reminder,
          detailText,
          detailItems: buildDetailItems(detailText),
          // 用服务端算好的 detail_source 判断。
          // 原来写的是 reminder.ai_generated_at，但接口从来没返回过这个字段，
          // 所以"原地重新生成"之后标签永远停在知识库来源（真 bug，见 AI调教与界面改进方案 B-4）。
          detailSourceText: DETAIL_SOURCE_TEXT[reminder.detail_source] || this.data.detailSourceText,
          generateButtonText: '重新生成这份方案',
          generating: false,
          estimateText: '',
          elapsed: 0
        })

        this.showNotice(data.generated ? '方案已更新' : '已是最新方案')
      })
      .catch((err) => {
        this.stopTimer()
        this.setData({
          generating: false,
          estimateText: '',
          elapsed: 0,
          error: err.detail || err.message || '方案生成失败'
        })
      })
  },

  onRegenerate() {
    wx.showModal({
      title: '哪里不合适？',
      editable: true,
      placeholderText: '例如：家里没有喷壶 / 现在室温只有 10 度 / 花盆比写的小',
      confirmText: '重新生成',
      success: (res) => {
        if (!res.confirm) return
        this.generateDetail(true, (res.content || '').trim())
      }
    })
  },

  /**
   * 用户自己确认当前土壤状态。
   * 第一次点进浇水提醒详情时会先问一次，作为水分账户的起点；
   * 之后想改也可以随时点（卡片上的四个按钮一直在）。
   */
  onSetWaterBaseline(event) {
    const level = event.currentTarget.dataset.level
    if (!level || this.data.savingBaseline) return

    this.setData({ savingBaseline: true })
    request({
      url: '/reminders/' + this.data.id + '/water-baseline',
      method: 'POST',
      data: { level }
    })
      .then((data) => {
        const reminder = data.reminder || {}
        this.setData({
          savingBaseline: false,
          reminder,
          water: reminder.water || null,
          waterPercentText: reminder.water ? reminder.water.tank_percent + '%' : '',
          summary: reminder.summary_text || this.data.summary,
          ...waterDerived(reminder.water)
        })
        this.showNotice('已记下：土壤' + (data.baseline ? data.baseline.label : '') + '，下次浇水日期重新算过了')
      })
      .catch((err) => {
        this.setData({ savingBaseline: false })
        this.showNotice(err.detail || err.message || '保存失败')
      })
  },

  // 重新生成“下一轮提醒”的 AI 建议（自动生成失败后可重试）
  onRegenerateAdvice() {
    if (this.data.regeneratingAdvice) return

    this.setData({
      regeneratingAdvice: true,
      aiError: '',
      estimateText: '预计 10-40 秒，请保持页面打开'
    })
    this.startTimer()

    request({
      url: '/reminders/' + this.data.id + '/ai-advice',
      method: 'POST',
      timeout: 300000
    })
      .then((data) => {
        this.stopTimer()
        const reminder = data.reminder || {}

        this.setData({
          reminder,
          summary: reminder.summary_text || this.data.summary,
          detailText: reminder.detail_content || this.data.detailText,
          detailSourceText: DETAIL_SOURCE_TEXT[reminder.detail_source] || this.data.detailSourceText,
          aiStatus: reminder.ai_status || 'done',
          aiError: reminder.ai_error || '',
          aiReason: reminder.ai_reason || '',
          regeneratingAdvice: false,
          estimateText: '',
          elapsed: 0
        })

        this.showNotice('已重新安排下一轮')
      })
      .catch((err) => {
        this.stopTimer()
        this.setData({
          regeneratingAdvice: false,
          estimateText: '',
          elapsed: 0,
          aiStatus: 'failed',
          aiError: err.detail || err.message || 'AI 建议生成失败'
        })
      })
  },

  onFeedbackEffective() {
    this.submitFeedback(true)
  },

  onFeedbackIneffective() {
    this.submitFeedback(false)
  },

  submitFeedback(effective) {
    if (this.data.submitting) return
    if (this.data.reminder && this.data.reminder.status === 'completed') {
      this.showNotice('这条反馈已经提交过了')
      return
    }
    this.setData({ submitting: true })

    request({
      url: '/reminders/' + this.data.id + '/treatment-feedback',
      method: 'POST',
      data: { effective }
    })
      .then((data) => {
        this.setData({ submitting: false })

        if (data.closed) {
          this.setData({
            stage: 'result',
            resultTitle: '本轮用药结束',
            resultText: '已记录「有效」，这个用药周期就到这里。记得继续保持通风、及时清理落叶，' +
              '如果以后又出现新的病斑，可以再做一次 AI 诊断。',
            nextReminders: []
          })
          return
        }

        if (data.need_ai_follow_up) {
          this.setData({
            stage: 'consult',
            resultTitle: '两个疗程都没有明显改善',
            resultText: '这种情况通常说明病菌产生了抗药性，或者喷药时漏掉了叶背。' +
              '接下来让 AI 结合这两轮的记录，判断要不要换药。'
          })
          this.startConsult()
          return
        }

        const list = [
          reminderLine('喷药提醒', data.next_treatment),
          reminderLine('效果询问', data.next_feedback)
        ].filter(Boolean)

        this.setData({
          stage: 'result',
          resultTitle: '已安排第 ' + (Number(data.round || 1) + 1) + ' 轮喷药',
          resultText: '下一轮的喷药方案和效果询问已经加到每日提醒里，' +
            '到达效果询问时间后会再问你一次有没有好转。',
          nextReminders: list
        })
      })
      .catch((err) => {
        this.setData({ submitting: false })
        wx.showToast({
          title: err.message || '提交失败',
          icon: 'none'
        })
      })
  },

  startConsult() {
    if (this.data.consulting) return

    this.setData({
      consulting: true,
      consultError: '',
      estimateText: '预计 10-40 秒，请保持页面打开'
    })
    this.startTimer()

    request({
      url: '/reminders/' + this.data.id + '/treatment-consult',
      method: 'POST',
      timeout: 300000
    })
      .then((data) => {
        this.stopTimer()
        this.setData({
          consulting: false,
          suggestion: (data.consult && data.consult.suggestion) || '',
          estimateText: '',
          elapsed: 0
        })
      })
      .catch((err) => {
        this.stopTimer()
        this.setData({
          consulting: false,
          estimateText: '',
          elapsed: 0,
          consultError: err.detail || err.message || 'AI 判断失败'
        })
      })
  },

  onRetryConsult() {
    this.startConsult()
  },

  onApplySuggestion() {
    if (this.data.applying) return
    this.setData({ applying: true })

    request({
      url: '/reminders/' + this.data.id + '/treatment-consult/apply',
      method: 'POST',
      data: { suggestion: this.data.suggestion }
    })
      .then((data) => {
        const list = [
          reminderLine('喷药提醒', data.next_treatment),
          reminderLine('效果询问', data.next_feedback)
        ].filter(Boolean)

        this.setData({
          applying: false,
          stage: 'result',
          resultTitle: '已采用调整方案',
          resultText: '新的喷药提醒和效果询问已经加到每日提醒里，' +
            '完整方案可以回到植物详情页，点开这条喷药提醒查看。',
          nextReminders: list
        })
      })
      .catch((err) => {
        this.setData({ applying: false })
        wx.showToast({
          title: err.message || '操作失败',
          icon: 'none'
        })
      })
  },

  onSkipSuggestion() {
    request({
      url: '/reminders/' + this.data.id + '/treatment-consult/reject',
      method: 'POST',
      data: {}
    }).catch(() => null).then(() => {
      this.setData({
        stage: 'result',
        resultTitle: '本次不调整方案',
        resultText: '已经记录你的选择。这条效果询问不会再重复出现，' +
          '你可以随时在植物详情页手动添加新的喷药提醒。',
        nextReminders: []
      })
    })
  },

  onComplete() {
    if (!this.data.reminder) return
    // 换盆是事件型：要更新花盆/土壤并触发缓苗期，走独立的确认面板
    if (this.data.reminder.type === 'repot') {
      this.setData({ repotShow: true })
      return
    }
    // 先弹登记面板再完成，避免误触把没做的事记成做了
    this.setData({ sheetShow: true })
  },

  onRepotCancel() {
    this.setData({ repotShow: false })
  },

  onRepotSubmit(event) {
    const payload = event.detail || {}
    this.setData({ repotShow: false })

    request({
      url: '/reminders/' + this.data.id + '/repot',
      method: 'POST',
      data: payload
    })
      .then(() => {
        wx.showToast({ title: '已记录换盆', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 800)
      })
      .catch((err) => {
        wx.showToast({ title: err.message || '换盆记录失败', icon: 'none' })
      })
  },

  onSheetCancel() {
    this.setData({ sheetShow: false })
  },

  onSheetSubmit(event) {
    const payload = event.detail || {}
    this.setData({ sheetShow: false })

    request({
      url: '/reminders/' + this.data.id + '/complete',
      method: 'POST',
      data: payload
    })
      .then((data) => {
        wx.showToast({ title: '已记录', icon: 'none' })
        // 先留 5 秒撤销窗口，倒计时结束再退回上一层；
        // 期间点撤销就取消返回，页面留在这儿显示回滚后的状态
        this.setData({
          undoShow: true,
          undoToken: data.undo_token || '',
          undoSeconds: data.undo_seconds || 5
        })
      })
      .catch((err) => {
        wx.showToast({
          title: err.message || '操作失败',
          icon: 'none'
        })
      })
  },

  onUndo() {
    const token = this.data.undoToken
    this.setData({ undoShow: false, undoToken: '' })
    if (!token) return

    request({
      url: '/reminders/' + this.data.id + '/undo-complete',
      method: 'POST',
      data: { token }
    })
      .then(() => {
        wx.showToast({ title: '已撤销', icon: 'none' })
        this.fetchReminder()
      })
      .catch((err) => {
        wx.showToast({ title: err.message || '撤销失败', icon: 'none' })
      })
  },

  onUndoExpire() {
    this.setData({ undoShow: false, undoToken: '' })
    wx.navigateBack()
  },

  /** 太早档选了「只是安排到那天」：只改期，不记录完成 */
  onSheetReschedule(event) {
    const dueAt = (event.detail && event.detail.due_at) || ''
    this.setData({ sheetShow: false })

    request({
      url: '/reminders/' + this.data.id + '/reschedule',
      method: 'POST',
      data: { due_at: dueAt }
    })
      .then(() => {
        wx.showToast({ title: '已安排到那天', icon: 'none' })
        this.fetchReminder()
      })
      .catch((err) => {
        wx.showToast({ title: err.message || '改期失败', icon: 'none' })
      })
  },

  onDelete() {
    wx.showModal({
      title: '删除提醒',
      content: '确定删除这条提醒吗？',
      success: (res) => {
        if (!res.confirm) return

        request({
          url: '/reminders/' + this.data.id,
          method: 'DELETE'
        })
          .then(() => wx.navigateBack())
          .catch((err) => {
            wx.showToast({
              title: err.message || '删除失败',
              icon: 'none'
            })
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
