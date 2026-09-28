const config = require('./config')

/**
 * 弹出可输入的对话框，让用户直接改后端地址。
 *
 * 为什么必须有这条路径：真机上小程序发现不了电脑的局域网 IP，换网络后 IP 会变。
 * 如果只能改代码重新编译，用户每次换网络都得找电脑；
 * 现在在手机上就能改（首页报错卡片和「我的」页都有入口）。
 *
 * @param {object}   options
 * @param {Function} options.onDone 保存后的回调，参数是新的地址
 */
function editServerAddress(options) {
  const opts = options || {}

  wx.showModal({
    title: '后端地址',
    editable: true,
    content: config.getBaseUrl(),
    placeholderText: '例如 192.168.1.5:3000，留空恢复默认',
    confirmText: '保存',
    cancelText: '取消',
    success(res) {
      if (!res.confirm) return

      const filled = String(res.content || '').trim()
      const next = config.setBaseUrl(res.content)

      wx.showToast({
        title: filled ? '已保存' : '已恢复默认',
        icon: 'none'
      })

      if (typeof opts.onDone === 'function') opts.onDone(next)
    }
  })
}

module.exports = { editServerAddress }
