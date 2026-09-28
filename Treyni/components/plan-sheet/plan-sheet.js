/**
 * 计划一件事。
 *
 * 四类以内（浇水/施肥/打药/修剪）和换盆：**会改每日提醒的日期**，
 * 等于把这件事安排进提醒板块。
 * 四类以外：只记一条，不排提醒、不参与周期。
 *
 * 用户选「其他」时，如果写的内容命中了四类关键词，
 * 服务端会返回 need_confirm，这里弹一句询问——不能默默当成普通笔记。
 * 关键词表只在服务端有一份（server/src/services/plan.js），前端不复制。
 */
const { request } = require('../../utils/request')

// 前五项是"会影响每日提醒的"，最后一项是"只记一笔的"
const KINDS = [
  { key: 'watering', label: '浇水' },
  { key: 'fertilizing', label: '施肥' },
  { key: 'pesticide', label: '打药' },
  { key: 'pruning', label: '修剪' },
  { key: 'repot', label: '换盆' },
  { key: 'other', label: '其他' }
]

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function dateString(date) {
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

function friendlyDate(value, today) {
  if (!value) return ''
  if (value === today) return '今天'
  if (value === dateString(new Date(Date.now() + 86400000))) return '明天'
  const matched = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return matched ? Number(matched[2]) + ' 月 ' + Number(matched[3]) + ' 日' : value
}

Component({
  properties: {
    show: {
      type: Boolean,
      value: false
    },
    plantId: {
      type: null,
      value: ''
    }
  },

  data: {
    kinds: KINDS,
    kindIndex: 0,
    kindLabel: '浇水',
    dueDate: '',
    dueText: '',
    todayText: '',
    title: '',
    note: '',
    saving: false
  },

  observers: {
    show: function (show) {
      if (!show) return
      const today = dateString(new Date())
      this.setData({
        kindIndex: 0,
        kindLabel: KINDS[0].label,
        dueDate: today,
        dueText: '今天',
        todayText: today,
        title: '',
        note: '',
        saving: false
      })
    }
  },

  methods: {
    onPickKind(event) {
      const index = Number(event.currentTarget.dataset.index)
      this.setData({ kindIndex: index, kindLabel: this.data.kinds[index].label })
    },

    onDateChange(event) {
      const value = event.detail.value
      this.setData({ dueDate: value, dueText: friendlyDate(value, this.data.todayText) })
    },

    onTitleInput(event) {
      this.setData({ title: event.detail.value })
    },

    onNoteInput(event) {
      this.setData({ note: event.detail.value })
    },

    onCancel() {
      this.triggerEvent('cancel')
    },

    onSubmit() {
      if (this.data.saving) return
      const kind = this.data.kinds[this.data.kindIndex].key
      const title = String(this.data.title || '').trim()

      if (kind === 'other' && !title) {
        wx.showToast({ title: '要计划什么事？写一句吧', icon: 'none' })
        return
      }

      this.setData({ saving: true })
      this.send({ kind, due_at: this.data.dueDate, title, note: String(this.data.note || '').trim() }, false)
    },

    /**
     * @param {boolean} acceptKeyword 用户在"要不要顺便安排进每日提醒"里选了「不用」
     */
    send(payload, acceptKeyword, forceKind) {
      const body = Object.assign({}, payload, acceptKeyword ? { accept_keyword: true } : {})
      if (forceKind) body.kind = forceKind

      request({
        url: '/plants/' + this.data.plantId + '/plan',
        method: 'POST',
        data: body
      })
        .then((data) => {
          this.setData({ saving: false })

          // 服务端认出这段文字像四类以内的事，先问一句
          if (data.need_confirm && data.suggestion) {
            wx.showModal({
              title: '顺带安排进提醒吗',
              content: data.message,
              confirmText: '安排',
              cancelText: '不用',
              success: (res) => {
                if (res.confirm) {
                  // 按识别出来的类别再提交一次
                  this.setData({ saving: true })
                  this.send(payload, false, data.suggestion.kind)
                } else {
                  this.setData({ saving: true })
                  this.send(payload, true)
                }
              }
            })
            return
          }

          this.triggerEvent('done', data)
        })
        .catch((err) => {
          this.setData({ saving: false })
          wx.showToast({ title: err.message || '计划失败', icon: 'none' })
        })
    }
  }
})
