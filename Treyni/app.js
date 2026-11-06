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

    // vConsole / 调试开关。
    //
    // ⚠️ wx.setEnableDebug 的效果是**记在手机微信里、按小程序 appid 存的**，不是跟着某一次运行走：
    // 只要在开发版/体验版里开过一次，之后打开正式版照样带着 vConsole 浮窗
    // （2026-10-12 用户反馈「上线了手机上还有 vConsole」就是这么来的；而且正式版的胶囊菜单里
    //   用户自己看不到「关闭调试」，只能靠代码关）。
    //
    // 所以规矩改成：
    //   · 只在开发者工具里自动开（本机调试方便）；
    //   · 正式版主动关一次，把历史上留下的开关清掉；
    //   · 体验版/开发版不再自动开——要看日志去「我的 → 调试 → vConsole 浮窗」自己开。
    if (typeof wx.setEnableDebug === 'function') {
      try {
        const account = wx.getAccountInfoSync()
        const envVersion = account.miniProgram.envVersion
        const platform = String((wx.getSystemInfoSync() || {}).platform || '')
        if (platform === 'devtools') {
          wx.setEnableDebug({ enableDebug: true })
        } else if (envVersion === 'release') {
          wx.setEnableDebug({ enableDebug: false })
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
