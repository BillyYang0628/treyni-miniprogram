const { request } = require('../../utils/request')
const util = require('../../utils/util')
const { ICONS, TYPE_ICONS } = require('../../utils/icons')

Page({
  data: {
    icons: ICONS,
    id: '',
    loading: true,
    journal: null,
    plant: null,
    typeText: '',
    typeIcon: '',
    timeText: ''
  },

  onLoad(options) {
    this.setData({ id: options.id || '' })
    this.fetchJournal()
  },

  fetchJournal() {
    if (!this.data.id) return

    request({ url: '/journals/' + this.data.id })
      .then((data) => {
        const journal = data.journal || {}
        this.setData({
          journal,
          plant: data.plant || null,
          typeText: util.JOURNAL_TYPE_TEXT[journal.type] || '记录',
          typeIcon: TYPE_ICONS[journal.type] || ICONS.leaf,
          timeText: util.formatDateTime(journal.created_at),
          loading: false
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        wx.showModal({
          title: '打开失败',
          content: err.message || '这条养护记录可能已经被删除',
          showCancel: false,
          success: () => wx.navigateBack()
        })
      })
  },

  onPreviewImage() {
    const journal = this.data.journal
    if (!journal || !journal.image_url) return

    wx.previewImage({
      urls: [journal.image_url],
      current: journal.image_url
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
