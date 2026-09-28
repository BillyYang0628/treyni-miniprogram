const { request } = require('../../utils/request')

Page({
  data: {
    location: null,
    keyword: '',
    cities: [],
    loading: false,
    saving: false,
    error: ''
  },

  onLoad() {
    this.fetchLocation()
  },

  fetchLocation() {
    request({ url: '/users/me/location' })
      .then((data) => this.setData({ location: data.location }))
      .catch(() => {})
  },

  onInput(event) {
    this.setData({ keyword: event.detail.value })
  },

  onSearch() {
    const keyword = (this.data.keyword || '').trim()
    if (!keyword) {
      wx.showToast({ title: '请输入城市名称', icon: 'none' })
      return
    }

    this.setData({ loading: true, error: '', cities: [] })

    request({ url: '/weather/city-search?keyword=' + encodeURIComponent(keyword) })
      .then((data) => {
        this.setData({
          cities: data.cities || [],
          loading: false
        })
      })
      .catch((err) => {
        this.setData({
          loading: false,
          // detail 里带排查步骤（是不是连不上后端），页面内联展示，比一句话有用
          error: err.detail || err.message || '搜索失败，请检查网络或稍后重试'
        })
      })
  },

  onPick(event) {
    const index = Number(event.currentTarget.dataset.index)
    const city = this.data.cities[index]
    if (!city || this.data.saving) return

    this.setData({ saving: true })

    request({
      url: '/users/me/location',
      method: 'PUT',
      data: {
        city: city.name,
        district: city.district,
        location_id: city.id,
        lat: city.lat,
        lon: city.lon
      }
    })
      .then(() => {
        wx.showToast({ title: '已设为养护位置', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 700)
      })
      .catch((err) => {
        this.setData({ saving: false })
        wx.showToast({ title: err.message || '保存失败', icon: 'none' })
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
