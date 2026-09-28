/**
 * 写一条记录。
 *
 * 需求（2026-09-18）：写记录就是**纯图片 + 纯文字**，只记录已经发生的事。
 * 以前这里的"浇水/施肥/打药/修剪"选项会顺手把每日提醒标记完成，
 * 和提醒板块重叠了——现在那部分交给「+ 计划」和提醒本身的完成按钮。
 */
const { upload } = require('../../utils/request')

Component({
  properties: {
    show: {
      type: Boolean,
      value: false
    }
  },

  data: {
    content: '',
    imageUrl: '',
    uploading: false,
    saving: false
  },

  observers: {
    show: function (show) {
      if (show) this.setData({ content: '', imageUrl: '', uploading: false, saving: false })
    }
  },

  methods: {
    onInput(event) {
      this.setData({ content: event.detail.value })
    },

    onChooseImage() {
      if (this.data.uploading) return
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        success: (res) => {
          const filePath = res.tempFiles && res.tempFiles[0] && res.tempFiles[0].tempFilePath
          if (filePath) this.uploadImage(filePath)
        }
      })
    },

    uploadImage(filePath) {
      this.setData({ uploading: true })
      upload({ url: '/storage', filePath, name: 'file', formData: { category: 'plants' } })
        .then((data) => {
          this.setData({ imageUrl: data.url || '', uploading: false })
        })
        .catch((err) => {
          this.setData({ uploading: false })
          wx.showToast({ title: err.message || '图片上传失败', icon: 'none' })
        })
    },

    onClearImage() {
      this.setData({ imageUrl: '' })
    },

    onCancel() {
      this.triggerEvent('cancel')
    },

    onSubmit() {
      if (this.data.saving) return
      const content = String(this.data.content || '').trim()
      if (!content && !this.data.imageUrl) {
        wx.showToast({ title: '写点什么，或者放张图', icon: 'none' })
        return
      }
      this.setData({ saving: true })
      this.triggerEvent('submit', { content, image_url: this.data.imageUrl })
    }
  }
})
