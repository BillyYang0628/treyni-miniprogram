const config = require('../config')

class WechatService {
  async code2Session(code) {
    if (!config.wechat.appid || !config.wechat.secret) {
      const err = new Error('微信登录尚未配置，请设置 WECHAT_APPID 和 WECHAT_SECRET')
      err.code = 'WECHAT_NOT_CONFIGURED'
      err.status = 503
      throw err
    }

    const url = new URL('https://api.weixin.qq.com/sns/jscode2session')
    url.searchParams.set('appid', config.wechat.appid)
    url.searchParams.set('secret', config.wechat.secret)
    url.searchParams.set('js_code', code)
    url.searchParams.set('grant_type', 'authorization_code')

    const response = await fetch(url)
    const data = await response.json()

    if (!response.ok || data.errcode) {
      const err = new Error(data.errmsg || '微信登录失败')
      err.code = data.errcode ? `WECHAT_${data.errcode}` : 'WECHAT_HTTP_ERROR'
      err.status = 502
      throw err
    }

    return data
  }
}

module.exports = new WechatService()
