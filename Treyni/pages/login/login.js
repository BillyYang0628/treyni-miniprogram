const auth = require('../../utils/auth')
const session = require('../../utils/session')

/**
 * 登录页：账号 + 口令。
 *
 * 账号不在这里注册，只能由管理员在服务端生成后私下发放
 * （tools/admin/create-account.js）。所以这一页只做一件事：把凭据换成 token。
 */
Page({
  data: {
    username: '',
    password: '',
    error: '',
    submitting: false
  },

  onShow() {
    // 已经有登录态就不用再登一次
    if (session.getToken()) {
      wx.reLaunch({ url: '/pages/garden/garden' })
    }
  },

  onUsername(event) {
    this.setData({ username: event.detail.value, error: '' })
  },

  onPassword(event) {
    this.setData({ password: event.detail.value, error: '' })
  },

  async onSubmit() {
    if (this.data.submitting) return

    const username = String(this.data.username || '').trim()
    const password = String(this.data.password || '')

    if (!username || !password) {
      this.setData({ error: '请把账号和口令都填上' })
      return
    }

    this.setData({ submitting: true, error: '' })
    try {
      await auth.login(username, password)
      wx.showToast({ title: '登录成功', icon: 'success', duration: 800 })
      setTimeout(() => wx.reLaunch({ url: '/pages/garden/garden' }), 400)
    } catch (err) {
      this.setData({ error: (err && err.message) || '登录失败，请重试' })
    } finally {
      this.setData({ submitting: false })
    }
  }
})
