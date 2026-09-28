const config = require('./config')
const session = require('./session')

/** 从完整地址里取出 host:port，报错和提示里都展示这个 */
function hostOf(url) {
  const matched = String(url || '').match(/^https?:\/\/([^/]+)/i)
  return matched ? matched[1] : String(url || '')
}

/** 127.0.0.1 / localhost 这种只有开发者工具会用，排查方向和真机完全不同 */
function isLoopbackHost(host) {
  return /^(127\.|localhost\b|0\.0\.0\.0\b)/i.test(String(host || ''))
}

// 开发者工具连不上：几乎只有一个原因——后端进程没起来
const LOOPBACK_HINT = '这是开发者工具专用的本机地址，连不上通常就是后端没在运行。\n' +
  '在项目根目录双击 start-server.cmd（或执行 cd server 后 npm start），\n' +
  '看到「托蕾妮小程序后端已启动」之后再点下面的「重试」。'

// 真机连不上：IP、Wi-Fi、后端三件事都要看
const LAN_HINT = '这是给真机用的局域网地址，依次检查：\n' +
  '1. 电脑上的后端是否在运行（项目根目录的 start-server.cmd）；\n' +
  '2. 手机和电脑是否连在同一个 Wi-Fi（有些公共 Wi-Fi 会互相隔离）；\n' +
  '3. 这个地址是不是电脑当前的局域网地址——换网络后 IP 会变，\n' +
  '   后端启动时会打印新地址，点下面的「改地址」填进去即可。'

/**
 * 把 wx.request 的原始错误翻译成人能看懂的话。
 *
 * 背景：真机连不上时页面只会弹 `request:fail timeout`——微信的错误码，
 * 用户看不懂也不知道该改什么。现在带上「连不上的具体地址」，
 * 并按地址是回环还是局域网给不同的排查方向。
 */
function describeNetworkError(url, err) {
  const raw = (err && err.errMsg) || ''
  const host = hostOf(url)
  const hint = isLoopbackHost(host) ? LOOPBACK_HINT : LAN_HINT
  const timedOut = /timeout|timed out/i.test(raw)
  const prefix = timedOut ? '连接后端超时（' : '连不上后端（'

  // 开发阶段把微信的原始错误码一并显示出来。
  // request:fail 后面的那几个词（timeout / url not in domain list / ERR_CONNECTION_REFUSED）
  // 才是定性的关键，光看"连不上"没法判断是网络、是域名校验还是后端没起。
  // 正式版不显示，用户不需要看这些。
  const diagnostic = config.isDevEnv() ? '\n（诊断信息：' + (raw || '无') + '）' : ''

  if (/domain list|not in domain/i.test(raw)) {
    return {
      code: -1,
      url,
      isDomainError: true,
      message: '请求域名没通过校验',
      detail: '当前要访问 ' + host + '，但微信只允许已备案的 https 域名。' +
        '开发阶段请在开发者工具「详情 → 本地设置」里勾选「不校验合法域名…」，再重新真机调试。' +
        diagnostic
    }
  }

  if (timedOut || /fail/i.test(raw)) {
    return {
      code: -1,
      url,
      isNetworkError: true,
      message: prefix + host + '）',
      detail: prefix + host + '）。\n' + hint + diagnostic
    }
  }

  return {
    code: -1,
    url,
    message: raw || '网络请求失败',
    detail: '请求 ' + String(url || '') + ' 失败' + (raw ? '：' + raw : '') + diagnostic
  }
}

/** 发一次请求，不做任何兜底 */
function sendRequest(url, options, token) {
  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method: options.method || 'GET',
      data: options.data || {},
      timeout: options.timeout || config.timeout,
      header: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(options.header || {})
      },
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data)
          return
        }

        // 401 = 登录态失效（token 过期或后端找不到）。标出来让上层自动重登。
        if (res.statusCode === 401) {
          reject({
            code: res.statusCode,
            url,
            isAuthError: true,
            message: (res.data && res.data.error) || '登录已过期'
          })
          return
        }

        reject({
          code: res.statusCode,
          url,
          message: (res.data && res.data.error) || '请求失败'
        })
      },
      fail(err) {
        // 真机调试窗口的 vConsole 里也能看到这条，方便直接复制原始错误码
        console.warn('[request] ' + url + ' -> ' + ((err && err.errMsg) || 'unknown'))
        reject(describeNetworkError(url, err))
      }
    })
  })
}

/** 探一下这个地址上有没有后端在跑（只打 /health，超时很短） */
function probe(baseUrl) {
  return new Promise((resolve) => {
    wx.request({
      url: baseUrl + '/health',
      method: 'GET',
      timeout: config.probeTimeout,
      success: (res) => resolve(res.statusCode >= 200 && res.statusCode < 300),
      fail: () => resolve(false)
    })
  })
}

/**
 * 连不上时顺着「用过的地址」往下试，谁的通就用谁，并记住。
 *
 * 为什么需要：这台电脑一小时内在 10.11.21.3 / 192.168.55.176 之间换过两次网，
 * 每次都要求用户改代码或手动填地址。候选列表见 config.js 的 LAN_HOSTS。
 * 自动切换时会弹提示告诉用户切到了哪，不做静默行为。
 */
async function sendWithFallback(path, options, token, firstError) {
  const tried = hostOf(firstError.url)
  const order = config.getProbeOrder()

  for (const baseUrl of order) {
    if (hostOf(baseUrl) === tried) continue
    const alive = await probe(baseUrl)
    if (!alive) continue

    config.setBaseUrl(baseUrl)
    wx.showToast({
      title: '已自动连上 ' + hostOf(baseUrl),
      icon: 'none',
      duration: 2500
    })
    return sendRequest(baseUrl + path, options, token)
  }

  // 一个都不通，把最开始那个错误原样抛出去（它的提示里已经有排查步骤）
  throw firstError
}

function request(options) {
  const path = options.url
  const url = path.startsWith('http') ? path : config.getBaseUrl() + path
  const absolute = path.startsWith('http')

  return sendRequest(url, options, session.getToken()).catch((err) => {
    // 登录态过期：清掉旧的，静默换一个新的，再把刚才那次请求重发一遍。
    // 只重试一次——重登之后还 401，说明不是 token 的问题，直接把错误抛出去。
    if (err.isAuthError) {
      session.clear()
      return session.reLogin().then(
        () => sendRequest(url, options, session.getToken()),
        (loginErr) => {
          throw {
            code: 401,
            url,
            isAuthError: true,
            message: '登录态已失效',
            detail: '自动重新登录没成功：' + (loginErr.message || '未知原因') +
              '\n请到「我的」页点「微信登录」，然后再试一次。'
          }
        }
      )
    }

    // 网络问题：换个候选地址再试（绝对地址不参与）
    if (!absolute && err.isNetworkError) {
      return sendWithFallback(path, options, session.getToken(), err)
    }

    throw err
  })
}

function upload(options) {
  const token = session.getToken()
  const url = options.url.startsWith('http')
    ? options.url
    : config.getBaseUrl() + options.url

  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url,
      filePath: options.filePath,
      name: options.name || 'file',
      formData: options.formData || {},
      header: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(options.header || {})
      },
      success(res) {
        let data = res.data
        if (typeof data === 'string') {
          try {
            data = JSON.parse(data)
          } catch (e) {
            // keep raw string
          }
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data)
        } else {
          reject({
            code: res.statusCode,
            url,
            message: (data && data.error) || '上传失败'
          })
        }
      },
      fail(err) {
        console.warn('[upload] ' + url + ' -> ' + ((err && err.errMsg) || 'unknown'))
        reject(describeNetworkError(url, err))
      }
    })
  })
}

module.exports = { request, upload }
