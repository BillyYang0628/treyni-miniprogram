const auth = require('../../utils/auth')
const { request } = require('../../utils/request')
const { ICONS, weatherIcon: pickWeatherIcon } = require('../../utils/icons')
const config = require('../../utils/config')
const { editServerAddress } = require('../../utils/serverAddress')

Page({
  data: {
    icons: ICONS,
    userInfo: null,
    loggingIn: false,
    location: null,
    weather: null,
    weatherIcon: '',
    weatherLoading: false,
    weatherError: '',
    subscribeConfigured: false,
    subscribeTemplateId: '',
    subscribeStatus: '',
    // 调试用：只在本机 / 真机调试 / 体验版显示，正式版自动隐藏
    devMode: false,
    serverUrl: ''
  },

  onShow() {
    const userInfo = wx.getStorageSync('userInfo')
    this.setData({
      userInfo: userInfo || null,
      devMode: config.isDevEnv(),
      serverUrl: config.getBaseUrl()
    })
    this.fetchLocationWeather()
    this.fetchSubscribeStatus()
  },

  /**
   * 改后端地址。
   * 真机上小程序没法自己发现电脑的局域网 IP，换网络后 IP 会变，
   * 以前只能改代码重新编译；现在在这里改一次就记住了。
   */
  onEditServer() {
    editServerAddress({
      onDone: (next) => {
        this.setData({ serverUrl: next })
      }
    })
  },

  fetchSubscribeStatus() {
    request({ url: '/config/subscribe' })
      .then((data) => {
        this.setData({
          subscribeConfigured: Boolean(data.configured),
          subscribeTemplateId: data.template_id || ''
        })
        return request({ url: '/users/me/subscriptions' })
      })
      .then((data) => {
        const list = (data && data.subscriptions) || []
        const accepted = list.find((item) => item.status === 'accepted')
        this.setData({ subscribeStatus: accepted ? '已开启' : '' })
      })
      .catch(() => {})
  },

  onSubscribe() {
    if (!this.data.subscribeConfigured) {
      wx.showModal({
        title: '还不能开启',
        content: '需要先在小程序后台申请订阅消息模板，并把模板 ID 配置到服务端（WECHAT_SUBSCRIBE_TEMPLATE_ID）。' +
          '模板申请下来后，这里就能一键开启提醒推送。',
        showCancel: false
      })
      return
    }

    wx.requestSubscribeMessage({
      tmplIds: [this.data.subscribeTemplateId],
      success: (res) => {
        const accepted = res[this.data.subscribeTemplateId] === 'accept'
        request({
          url: '/users/me/subscriptions',
          method: 'POST',
          data: { template_id: this.data.subscribeTemplateId, accepted }
        })
          .then(() => {
            this.setData({ subscribeStatus: accepted ? '已开启' : '' })
            wx.showToast({
              title: accepted ? '已开启提醒' : '未开启',
              icon: accepted ? 'success' : 'none'
            })
          })
          .catch(() => wx.showToast({ title: '保存失败', icon: 'none' }))
      },
      fail: () => wx.showToast({ title: '授权失败，请重试', icon: 'none' })
    })
  },

  fetchLocationWeather() {
    request({ url: '/users/me/location' })
      .then((data) => {
        this.setData({ location: data.location || null })

        if (!data.location) {
          this.setData({ weather: null, weatherIcon: '', weatherError: '' })
          return
        }

        this.setData({ weatherLoading: true, weatherError: '' })
        return request({ url: '/weather/current' })
          .then((weather) => {
            this.setData({
              weatherIcon: pickWeatherIcon(weather.now && weather.now.text),
              weather: {
                now: weather.now,
                today: (weather.daily || [])[0] || null,
                warnings: weather.warnings || []
              },
              weatherLoading: false
            })
          })
          .catch((err) => {
            this.setData({
              weather: null,
              weatherIcon: '',
              weatherLoading: false,
              weatherError: err.detail || err.message || '天气获取失败'
            })
          })
      })
      .catch(() => {
        this.setData({ location: null, weather: null, weatherIcon: '' })
      })
  },

  goCity() {
    wx.navigateTo({ url: '/pages/city/city' })
  },

  goGarden() {
    wx.switchTab({
      url: '/pages/garden/garden',
      fail() {
        wx.navigateTo({ url: '/pages/garden/garden' })
      }
    })
  },

  goCareGuide() {
    wx.navigateTo({ url: '/pages/care-guide/care-guide?section=pot_size' })
  },

  onAbout() {
    wx.showModal({
      title: '关于托蕾妮',
      content: '托蕾妮 · 微信小程序 demo\n\n' +
        '植物养护提醒会结合品种知识库和当地天气推算；\n' +
        'AI 诊断与对话使用百度植物识别 + Moonshot Kimi。\n' +
        '目前为开发验收阶段，功能持续完善中。',
      showCancel: false
    })
  },

  async onLogin() {
    if (this.data.loggingIn) return

    this.setData({ loggingIn: true })
    try {
      const data = await auth.login()
      this.setData({ userInfo: data.user })
      wx.showToast({
        title: '登录成功',
        icon: 'success'
      })
    } catch (err) {
      wx.showModal({
        title: '登录失败',
        content: err.message || '请确认后端服务已启动并配置微信登录',
        showCancel: false
      })
    } finally {
      this.setData({ loggingIn: false })
    }
  }
})
