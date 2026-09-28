/**
 * 后端地址。
 *
 * 背景：真机上的小程序**没法自己发现电脑的局域网 IP**，只能写死一个；
 * 而这个 IP 会随网络环境变。2026-09-16 真机一进去就 request fail，
 * 就是电脑换到了 10.11.x 网段，这里还留着旧的 192.168.1.4。
 *
 * 所以地址分三层，按优先级从高到低：
 *   1. 手动设置过的地址（存在本地缓存里）——「我的」页最下面有入口，
 *      真机上改一次就记住，不用重新编译；
 *   2. 开发者工具固定走 127.0.0.1；
 *   3. 真机走下面的 LAN_HOST。
 *
 * 换网络后如果忘了改，首页会把「连不上哪个地址」直接显示出来，不会再报
 * 那个看不懂的 request:fail timeout。
 */

// 后端每次启动都会把当前电脑的局域网地址写进 lan-host.generated.js，
// 这里优先读它——"启动后端"这个动作本身就完成了地址同步，不用手改代码。
let generatedHost = ''
try {
  generatedHost = require('./lan-host.generated.js').host || ''
} catch (e) {
  // 还没启动过后端时这个文件不存在，走下面的兜底列表
  generatedHost = ''
}

// 兜底候选：生成文件不存在，或者地址又变了，就会顺着这些往下试。
// 这台机器三天内换过三个网段，都留在这里当候选，换回去也不用管。
const FALLBACK_HOSTS = [
  '192.168.1.4',    // 2026-09-17
  '192.168.55.176', // 2026-09-16 晚
  '10.11.21.3'      // 2026-09-16 白天
]

// 生成的地址排最前，其余按顺序去重
const LAN_HOSTS = [generatedHost].concat(FALLBACK_HOSTS).filter(function (host, index, list) {
  return Boolean(host) && list.indexOf(host) === index
})

// 兼容旧引用：需要单个"当前局域网 IP"的地方取第一个
const LAN_HOST = LAN_HOSTS[0]

const PORT = 3000
const DEVTOOLS_ORIGIN = 'http://127.0.0.1:' + PORT
const LAN_ORIGIN = 'http://' + LAN_HOST + ':' + PORT

// 自动切换时探测候选地址用的超时。只探一个 /health，不该等太久。
const PROBE_TIMEOUT = 3000

// 手动覆盖用的缓存 key，「我的」页的调试入口写这个
const OVERRIDE_KEY = 'debug_baseUrl'

function getPlatform() {
  try {
    if (typeof wx === 'undefined') return 'devtools'
    if (wx.getDeviceInfo) return wx.getDeviceInfo().platform || 'devtools'
    if (wx.getSystemInfoSync) return wx.getSystemInfoSync().platform || 'devtools'
  } catch (e) {
    // 取不到就按开发者工具处理
  }
  return 'devtools'
}

/**
 * 是否开发 / 体验环境。
 * 用来决定要不要在界面上暴露诊断信息（原始错误码之类）——正式版不给用户看这些。
 */
function isDevEnv() {
  try {
    if (typeof wx === 'undefined') return true
    const account = wx.getAccountInfoSync()
    return Boolean(account && account.miniProgram && account.miniProgram.envVersion !== 'release')
  } catch (e) {
    // 取不到环境信息时按正式版处理，宁可少显示
    return false
  }
}

/** 用户可能只输 `10.0.0.5` 或 `10.0.0.5:3000`，这里补齐协议和端口 */
function normalizeBaseUrl(input) {
  let value = String(input || '').trim().replace(/\/+$/, '')
  if (!value) return ''
  if (!/^https?:\/\//i.test(value)) value = 'http://' + value

  // 没写端口就补上默认端口（已经写了 http:// 带路径的除外）
  const matched = value.match(/^https?:\/\/([^/]+)(\/.*)?$/i)
  if (matched && matched[1].indexOf(':') === -1) {
    value = value.replace(/^(https?:\/\/[^/]+)/i, '$1:' + PORT)
  }
  return value
}

/** 没有手动覆盖时的默认地址 */
function getDefaultBaseUrl() {
  return getPlatform() === 'devtools' ? DEVTOOLS_ORIGIN : LAN_ORIGIN
}

/**
 * 按顺序列出所有可以试的地址（当前地址排最前）。
 * request.js 在连不上时会顺着这个列表往下试，试通了就记成手动地址。
 */
function getProbeOrder() {
  const current = getBaseUrl()
  const all = [DEVTOOLS_ORIGIN].concat(
    LAN_HOSTS.map(function (host) { return 'http://' + host + ':' + PORT })
  )

  const order = [current]
  const seen = {}
  seen[current] = true
  all.forEach(function (url) {
    if (!seen[url]) {
      seen[url] = true
      order.push(url)
    }
  })
  return order
}

/** 手动设置过的地址，没有就返回空字符串 */
function getOverrideBaseUrl() {
  try {
    return normalizeBaseUrl(wx.getStorageSync(OVERRIDE_KEY))
  } catch (e) {
    return ''
  }
}

/**
 * 当前生效的后端地址。
 * 每次请求都会重新算，所以在「我的」页改完立刻生效，不用重启小程序。
 */
function getBaseUrl() {
  return getOverrideBaseUrl() || getDefaultBaseUrl()
}

/**
 * 手动设置后端地址；传空字符串表示清除覆盖，回到默认值。
 * @returns {string} 设置之后生效的地址
 */
function setBaseUrl(input) {
  const value = normalizeBaseUrl(input)
  try {
    if (value) wx.setStorageSync(OVERRIDE_KEY, value)
    else wx.removeStorageSync(OVERRIDE_KEY)
  } catch (e) {
    // 缓存写不进去也不影响本次返回
  }
  return getBaseUrl()
}

module.exports = {
  getBaseUrl,
  setBaseUrl,
  getDefaultBaseUrl,
  getOverrideBaseUrl,
  getProbeOrder,
  isDevEnv,
  normalizeBaseUrl,
  lanHost: LAN_HOST,
  lanHosts: LAN_HOSTS,
  port: PORT,
  probeTimeout: PROBE_TIMEOUT,
  timeout: 15000
}
