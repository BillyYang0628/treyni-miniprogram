const config = require('./utils/config')
const session = require('./utils/session')

App({
  onLaunch() {
    const token = session.getToken()
    const userInfo = wx.getStorageSync('userInfo')

    this.globalData.token = token || ''
    this.globalData.userInfo = userInfo || null

    // 没有登录态就先静默登一次。
    // 后端 token 有效期 7 天，过期后所有接口都会返回 401；
    // request.js 里也有 401 自动重登的兜底，这里只是让首屏少一次失败的往返。
    if (!token) {
      session.reLogin().then(
        (data) => {
          this.globalData.token = data.token
          this.globalData.userInfo = data.user || null
        },
        () => {
          // 登录失败不拦启动，页面自己的报错卡片会说明原因
        }
      )
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
