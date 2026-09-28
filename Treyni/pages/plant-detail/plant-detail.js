const { request } = require('../../utils/request')
const util = require('../../utils/util')
const { ICONS, TYPE_ICONS } = require('../../utils/icons')
const { overdueColor } = require('../../utils/overdue')

const REMINDER_AI_STATUS = {
  pending: '托蕾妮正在安排下一轮…',
  done: '已按这盆植物调整',
  failed: 'AI 建议生成失败，点进详情可重试'
}

/** 把 YYYY-MM-DD 显示成「9 月 20 日」 */
function friendlyDay(day) {
  const matched = String(day || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return matched ? Number(matched[2]) + ' 月 ' + Number(matched[3]) + ' 日' : String(day || '')
}

/** 距离某天还有几天（负数=已经过去） */
function daysFromToday(day) {
  const matched = String(day || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!matched) return null
  const target = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]))
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((target - today) / 86400000)
}

function withIcon(reminder) {
  const lateDays = Number(reminder.late_days) || 0

  return {
    ...reminder,
    icon: TYPE_ICONS[reminder.type] || ICONS.leaf,
    summary: reminder.summary_text || reminder.title,
    dueLabel: reminder.due_label || '',
    dueText: reminder.due_text || '',
    lateDays,
    // 逾期边框色：0 天就是原来的近黑，7 天封顶为明红（见 utils/overdue.js）
    overdueColor: overdueColor(lateDays),
    aiStatusText: REMINDER_AI_STATUS[reminder.ai_status] || '',
    aiFailed: reminder.ai_status === 'failed',
    aiStatusIcon: reminder.ai_status === 'failed' ? ICONS.failed
      : (reminder.ai_status === 'done' ? ICONS.done : ICONS.pending)
  }
}

Page({
  data: {
    icons: ICONS,
    sheetShow: false,
    sheetReminder: null,
    repotShow: false,
    repotReminder: null,
    writeShow: false,
    planShow: false,
    agenda: [],
    undoShow: false,
    undoSeconds: 5,
    undoToken: '',
    undoReminderId: null,
    plantId: '',
    plant: null,
    loading: true,
    journals: [],
    reminders: [],
    completedReminders: []
  },

  onLoad(options) {
    this.setData({
      plantId: options.id || ''
    })
    this.enableShareMenus()
  },

  // 从 AI 诊断等页面返回时重新拉取，保证每日提醒和养护历程实时更新
  onShow() {
    if (this.data.plantId) {
      this.fetchPlant()
    }
  },

  /** 转发这一盆。带上真实 id，别人点进来能直接看到这盆（见 品牌素材交接说明.md 第 2 步） */
  onShareAppMessage() {
    const plant = this.data.plant || {}
    return {
      title: plant.name ? ('托蕾妮 · ' + plant.name + '的养护计划') : '托蕾妮 · 植物养护助手',
      path: '/pages/plant-detail/plant-detail?id=' + this.data.plantId,
      imageUrl: '/assets/brand/share-cover.png'
    }
  },

  /** 分享到朋友圈：字段是 query 不是 path，且不带前导 ?（落到当前页面 + 这串参数） */
  onShareTimeline() {
    const plant = this.data.plant || {}
    return {
      title: plant.name ? ('托蕾妮 · ' + plant.name + '的养护计划') : '托蕾妮 · 植物养护助手',
      query: 'id=' + this.data.plantId,
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

  fetchPlant() {
    if (!this.data.plantId) return

    // 已有数据时不再显示整页加载态，避免从 AI 诊断返回时闪烁
    this.setData({ loading: !this.data.plant })
    request({ url: '/plants/' + this.data.plantId })
      .then((data) => {
        this.setData({
          plant: data.plant,
          loading: false
        })
        this.fetchReminders()
        this.fetchJournals()
      })
      .catch((err) => {
        this.setData({ loading: false })
        wx.showToast({
          title: err.message || '获取植物失败',
          icon: 'none'
        })
      })
  },

  fetchReminders() {
    request({ url: '/plants/' + this.data.plantId + '/reminders' })
      .then((data) => {
        const reminders = data.reminders || []
        this.setData({
          // status: pending 待办 / completed 已完成 / skipped 已跳过（"其实已经做过了"那种重复提醒）
          reminders: reminders
            .filter((item) => item.status === 'pending')
            .map(withIcon),
          completedReminders: reminders
            .filter((item) => item.status !== 'pending')
            .map(withIcon)
            .map((item) => ({
              ...item,
              skipped: item.status === 'skipped',
              completedText: item.status === 'skipped'
                ? '已跳过'
                : util.formatDateTime(item.completed_at)
            }))
            .sort((a, b) => {
              const at = a.completed_at || ''
              const bt = b.completed_at || ''
              return bt.localeCompare(at)
            })
        })
        this.computeAgenda()
      })
      .catch((err) => {
        wx.showToast({
          title: err.message || '获取提醒失败',
          icon: 'none'
        })
      })
  },

  fetchJournals() {
    request({ url: '/plants/' + this.data.plantId + '/journal' })
      .then((data) => {
        this.setData({
          journals: (data.journals || []).map((item) => ({
            ...item,
            typeText: util.JOURNAL_TYPE_TEXT[item.type] || '记录',
            typeIcon: TYPE_ICONS[item.type] || ICONS.leaf,
            // planned = 计划中的事，在时间线上单独标出来
            isPlanned: item.kind === 'planned',
            planDateText: item.occurred_at ? friendlyDay(item.occurred_at) : '',
            timeText: util.formatDateTime(item.created_at)
          }))
        })
        this.computeAgenda()
      })
      .catch((err) => {
        wx.showToast({
          title: err.message || '获取日记失败',
          icon: 'none'
        })
      })
  },

  goBack() {
    wx.navigateBack({
      fail() {
        wx.switchTab({
          url: '/pages/garden/garden'
        })
      }
    })
  },

  goEdit() {
    wx.navigateTo({
      url: '/pages/plant-form/plant-form?id=' + this.data.plantId
    })
  },

  goDiagnosis() {
    const plantName = this.data.plant && this.data.plant.name
      ? encodeURIComponent(this.data.plant.name)
      : ''
    wx.navigateTo({
      url: '/pages/diagnosis/diagnosis?plant_id=' + this.data.plantId + '&plant_name=' + plantName
    })
  },

  goChat() {
    wx.navigateTo({
      url: '/pages/chat/chat?plant_id=' + this.data.plantId
    })
  },

  goReport() {
    wx.navigateTo({
      url: '/pages/report/report?plant_id=' + this.data.plantId
    })
  },

  goReminderDetail(event) {
    const id = event.currentTarget.dataset.id
    wx.navigateTo({
      url: '/pages/reminder-detail/reminder-detail?id=' + id
    })
  },

  goJournalDetail(event) {
    const id = event.currentTarget.dataset.id
    wx.navigateTo({
      url: '/pages/journal-detail/journal-detail?id=' + id
    })
  },

  onDelete() {
    wx.showModal({
      title: '删除植物',
      content: '删除后无法恢复，确定继续吗？',
      success: (res) => {
        if (!res.confirm) return

        request({ url: '/plants/' + this.data.plantId, method: 'DELETE' })
          .then(() => {
            wx.showToast({
              title: '已删除',
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
            wx.showToast({
              title: err.message || '删除失败',
              icon: 'none'
            })
          })
      }
    })
  },

  onCompleteReminder(event) {
    const id = event.currentTarget.dataset.id
    const reminder = (this.data.reminders || []).find((item) => String(item.id) === String(id))
    if (!reminder) return

    // 换盆是事件型：要更新花盆/土壤并触发缓苗期，走独立的确认面板
    if (reminder.type === 'repot') {
      this.setData({ repotShow: true, repotReminder: reminder })
      return
    }

    // 先弹登记面板，而不是直接完成。
    // 面板的第一价值是防止误触把没做的事记成做了（见 components/complete-sheet）。
    this.setData({ sheetShow: true, sheetReminder: reminder })
  },

  onSheetCancel() {
    this.setData({ sheetShow: false, sheetReminder: null })
  },

  onRepotCancel() {
    this.setData({ repotShow: false, repotReminder: null })
  },

  /** 换盆确认：更新花盆/土壤 → 触发缓苗期 → 完成提醒 → 服务端重算浇水 */
  onRepotSubmit(event) {
    const reminder = this.data.repotReminder
    if (!reminder) return
    const payload = event.detail || {}
    this.setData({ repotShow: false })

    request({
      url: '/reminders/' + reminder.id + '/repot',
      method: 'POST',
      data: payload
    })
      .then((data) => {
        const tip = payload.skip_profile
          ? '已记录换盆'
          : ('已记录换盆' + (data.water_warning ? '（浇水暂时没重算成功）' : ''))
        wx.showToast({ title: tip, icon: 'none' })
        this.setData({ repotReminder: null })
        this.fetchReminders()
        this.fetchJournals()
        this.fetchPlant()
      })
      .catch((err) => {
        this.setData({ repotReminder: null })
        wx.showToast({ title: err.message || '换盆记录失败', icon: 'none' })
      })
  },

  onSheetSubmit(event) {
    const reminder = this.data.sheetReminder
    if (!reminder) return
    const payload = event.detail || {}
    // 连着完成两条时只保留最后一次的撤销凭据
    this.setData({ sheetShow: false, undoShow: false })

    request({
      url: '/reminders/' + reminder.id + '/complete',
      method: 'POST',
      data: payload
    })
      .then((data) => {
        wx.showToast({ title: '已记录', icon: 'none' })
        this.setData({
          sheetReminder: null,
          undoShow: true,
          undoToken: data.undo_token || '',
          undoSeconds: data.undo_seconds || 5,
          undoReminderId: reminder.id
        })
        this.fetchReminders()
        this.fetchJournals()
      })
      .catch((err) => {
        this.setData({ sheetReminder: null })
        wx.showToast({
          title: err.message || '完成失败',
          icon: 'none'
        })
      })
  },

  /** 5 秒内撤销：服务端按整行快照回滚（提醒状态、下一轮、养护历程、浇水事件） */
  onUndo() {
    const { undoToken, undoReminderId } = this.data
    this.setData({ undoShow: false, undoToken: '', undoReminderId: null })
    if (!undoToken || !undoReminderId) return

    request({
      url: '/reminders/' + undoReminderId + '/undo-complete',
      method: 'POST',
      data: { token: undoToken }
    })
      .then(() => {
        wx.showToast({ title: '已撤销', icon: 'none' })
        this.fetchReminders()
        this.fetchJournals()
      })
      .catch((err) => {
        wx.showToast({ title: err.message || '撤销失败', icon: 'none' })
      })
  },

  onUndoExpire() {
    this.setData({ undoShow: false, undoToken: '', undoReminderId: null })
  },

  /** 太早档选了「只是安排到那天」：只改期，不记录完成 */
  onSheetReschedule(event) {
    const reminder = this.data.sheetReminder
    if (!reminder) return
    const dueAt = (event.detail && event.detail.due_at) || ''
    this.setData({ sheetShow: false })

    request({
      url: '/reminders/' + reminder.id + '/reschedule',
      method: 'POST',
      data: { due_at: dueAt }
    })
      .then(() => {
        wx.showToast({ title: '已安排到那天', icon: 'none' })
        this.setData({ sheetReminder: null })
        this.fetchReminders()
      })
      .catch((err) => {
        this.setData({ sheetReminder: null })
        wx.showToast({ title: err.message || '改期失败', icon: 'none' })
      })
  },

  onDeleteReminder(event) {
    const id = event.currentTarget.dataset.id
    wx.showModal({
      title: '删除提醒',
      content: '确定删除这条提醒吗？',
      success: (res) => {
        if (!res.confirm) return

        request({
          url: '/reminders/' + id,
          method: 'DELETE'
        })
          .then(() => {
            this.fetchReminders()
          })
          .catch((err) => {
            wx.showToast({
              title: err.message || '删除失败',
              icon: 'none'
            })
          })
      }
    })
  },

  /**
   * 「+ 写记录」= 纯图片 + 纯文字。
   * 以前这里会弹"浇水/施肥/打药/修剪"，选了就顺手把每日提醒标记完成——
   * 那和提醒板块重叠了（用户 2026-09-18 指出的）。现在两件事分开：
   * 记录已经发生的事走这里，安排未来某天的事走「+ 计划」。
   */
  onWriteJournal() {
    this.setData({ writeShow: true })
  },

  onWriteCancel() {
    this.setData({ writeShow: false })
  },

  onWriteSubmit(event) {
    const detail = event.detail || {}
    this.setData({ writeShow: false })
    request({
      url: '/plants/' + this.data.plantId + '/journal',
      method: 'POST',
      data: { type: 'custom', content: detail.content || '', image_url: detail.image_url || '' }
    })
      .then(() => {
        wx.showToast({ title: '已记录', icon: 'none' })
        this.fetchJournals()
      })
      .catch((err) => {
        wx.showToast({ title: err.message || '记录失败', icon: 'none' })
      })
  },

  /** 「+ 计划」：四类以内会排进每日提醒，四类以外只记一笔 */
  onPlanSomething() {
    this.setData({ planShow: true })
  },

  onPlanCancel() {
    this.setData({ planShow: false })
  },

  onPlanDone() {
    this.setData({ planShow: false })
    wx.showToast({ title: '已安排', icon: 'none' })
    this.fetchReminders()
    this.fetchJournals()
  },

  /**
   * 「接下来要做的」聚合卡。
   *
   * 四类以内的提醒本来就在每日提醒里；这张卡的意义是让**四类以外的计划**
   * （买补光灯、换位置这些）也能被看见——否则用户设了日期却哪儿都看不到。
   * 所以两边都收：提醒看未来 3 天（含今天），计划看 ±7 天内的。
   */
  computeAgenda() {
    const items = []

    for (const r of this.data.reminders || []) {
      const days = Number(r.days_until_due)
      if (!Number.isFinite(days) || days > 3) continue
      items.push({
        key: 'r' + r.id,
        sort: days,
        when: r.dueLabel,
        text: r.title + '：' + (r.summary || ''),
        planned: false
      })
    }

    for (const j of this.data.journals || []) {
      if (!j.isPlanned) continue
      const days = daysFromToday(j.occurred_at)
      if (days === null || days > 7) continue
      items.push({
        key: 'j' + j.id,
        sort: days,
        when: days < 0 ? '已过 ' + (-days) + ' 天' : (days === 0 ? '今天' : (days === 1 ? '明天' : days + ' 天后')),
        text: j.content,
        planned: true
      })
    }

    items.sort((a, b) => a.sort - b.sort)
    this.setData({ agenda: items.slice(0, 5) })
  },

  createQuickAction(type, content) {
    request({
      url: '/plants/' + this.data.plantId + '/quick-action',
      method: 'POST',
      data: {
        type,
        content
      }
    })
      .then(() => {
        wx.showToast({
          title: '已完成并记录',
          icon: 'success'
        })
        this.fetchReminders()
        this.fetchJournals()
      })
      .catch((err) => {
        wx.showToast({
          title: err.message || '操作失败',
          icon: 'none'
        })
      })
  },

  onAddReminder() {
    wx.showModal({
      title: '添加提醒',
      editable: true,
      placeholderText: '例如：检查叶片背面',
      success: (res) => {
        if (!res.confirm || !res.content) return

        request({
          url: '/plants/' + this.data.plantId + '/reminders',
          method: 'POST',
          data: {
            type: 'custom',
            title: res.content,
            content: '手动添加的养护提醒',
            interval_days: 7
          }
        })
          .then(() => {
            wx.showToast({
              title: '已添加',
              icon: 'success'
            })
            this.fetchReminders()
          })
          .catch((err) => {
            wx.showToast({
              title: err.message || '添加失败',
              icon: 'none'
            })
          })
      }
    })
  },

  createCustomJournal() {
    wx.showModal({
      title: '写一条记录',
      editable: true,
      placeholderText: '记录这次做了什么，例如：发现新芽、换盆、喷药...',
      success: (res) => {
        if (res.confirm && res.content) {
          this.createJournal('custom', res.content)
        }
      }
    })
  },

  createJournal(type, content) {
    request({
      url: '/plants/' + this.data.plantId + '/journal',
      method: 'POST',
      data: {
        type,
        content
      }
    })
      .then(() => {
        wx.showToast({
          title: '已记录',
          icon: 'success'
        })
        this.fetchJournals()
      })
      .catch((err) => {
        wx.showToast({
          title: err.message || '记录失败',
          icon: 'none'
        })
      })
  }
})
