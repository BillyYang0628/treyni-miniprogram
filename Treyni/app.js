const config = require('./utils/config')
const session = require('./utils/session')

App({
  onLaunch() {
    const token = session.getToken()
    const userInfo = wx.getStorageSync('userInfo')

    this.globalData.token = token || ''
    this.globalData.userInfo = userInfo || null

    // 没有登录态直接去登录页：账号由管理员私下发放，客户端不做静默登录。
    // token 有效期 7 天，过期后 request.js 会清凭据并把人送回登录页。
    if (!token) {
      wx.reLaunch({ url: '/pages/login/login' })
    }

    if (typeof wx.setEnableDebug === 'function') {
      try {
        const account = wx.getAccountInfoSync()
        if (account.miniProgram.envVersion !== 'release') {
          wx.setEnableDebug({ enableDebug: true })
        }
      } catch (e) {
        // 低版本或环境不支持时忽略
      }
    }
  },

  globalData: {
    token: '',
    userInfo: null,
    config
  }
})
