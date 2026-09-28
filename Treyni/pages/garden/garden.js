const { request } = require('../../utils/request')
const util = require('../../utils/util')
const { ICONS } = require('../../utils/icons')
const config = require('../../utils/config')
const { editServerAddress } = require('../../utils/serverAddress')

Page({
  data: {
    icons: ICONS,
    loading: true,
    plants: [],
    // 连不上后端时的完整说明 + 当前用的地址。
    // 以前这里只弹一个 toast（内容是 request:fail timeout），一眨眼就没了，
    // 页面还会退化成"还没有添加植物"，看起来像没数据，其实是服务连不上。
    error: '',
    serverUrl: ''
  },

  onLoad() {
    this.enableShareMenus()
    this.fetchPlants()
  },

  onShow() {
    this.fetchPlants()
  },

  /**
   * 转发。2026-09-21 加：微信的规则是**页面没有定义这个函数时，右上角菜单里的「转发」是灰的**，
   * 所以品牌封面图必须和这个函数一起接，不然图放着也用不上。
   * 文案遵守 措辞规范.md：平实、不施压、不用感叹号。
   */
  onShareAppMessage() {
    return {
      title: '托蕾妮 · 我的花园',
      path: '/pages/garden/garden',
      imageUrl: '/assets/brand/share-cover.png'
    }
  },

  /**
   * 分享到朋友圈。和 onShareAppMessage 的区别（踩坑点）：
   *   · 字段是 **query** 不是 path，而且**不带前导 ?**、也不写页面路径
   *     —— 朋友圈分享固定落到「当前这个页面」，只能靠 query 带参数；
   *   · 需要在页面里调 wx.showShareMenu 把 shareTimeline 这个入口显出来。
   */
  onShareTimeline() {
    return {
      title: '托蕾妮 · 我的花园',
      imageUrl: '/assets/brand/share-cover.png'
    }
  },

  enableShareMenus() {
    // 基础库 2.11.3 起支持带 menus 参数；老版本没有这个方法，兜一下
    if (typeof wx.showShareMenu !== 'function') return
    wx.showShareMenu({
      menus: ['shareAppMessage', 'shareTimeline'],
      fail: (err) => console.warn('[share] showShareMenu 失败：' + (err && err.errMsg))
    })
  },

  fetchPlants() {
    this.setData({ loading: true, error: '', serverUrl: config.getBaseUrl() })

    request({ url: '/plants' })
      .then((data) => {
        this.setData({
          plants: (data.plants || []).map((item) => ({
            ...item,
            // 列表里只显示到“几月几日”，避免直接把数据库时间戳铺在卡片上
            createdDay: util.formatDay(item.created_at)
          })),
          loading: false,
          error: ''
        })
      })
      .catch((err) => {
        this.setData({
          loading: false,
          error: err.detail || err.message || '获取植物失败'
        })
      })
  },

  onRetry() {
    this.fetchPlants()
  },

  /**
   * 直接在报错卡片上改后端地址。
   * 真机换网络后 IP 会变，这一步能在手机上完成，不用回去改代码。
   */
  onEditServer() {
    editServerAddress({
      onDone: (next) => {
        this.setData({ serverUrl: next })
        this.fetchPlants()
      }
    })
  },

  onPullDownRefresh() {
    this.fetchPlants()
    setTimeout(() => wx.stopPullDownRefresh(), 800)
  },

  goAddPlant() {
    wx.navigateTo({
      url: '/pages/plant-form/plant-form'
    })
  },

  goPlantDetail(event) {
    const id = event.currentTarget.dataset.id
    wx.navigateTo({
      url: '/pages/plant-detail/plant-detail?id=' + id
    })
  }
})
