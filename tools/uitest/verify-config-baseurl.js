// config.js 的地址解析回归。
//
// 背景：以前只有「手动覆盖 → 开发者工具 127.0.0.1 → 局域网地址」三层，
// 正式版会把局域网地址当默认值，上线必然连不上；而装过体验版并改过地址的手机，
// 缓存里的旧 IP 会一直生效。这里把规则钉死：
//   正式版 = 只走备案域名，忽略覆盖和候选；非正式版才走局域网/开发工具。
const path = require('node:path')

let passed = 0
let failed = 0

function check(label, actual, expected) {
  const ok = String(actual) === String(expected)
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (ok) passed += 1
  else failed += 1
}

function makeWx({ envVersion = 'develop', platform = 'android', storage = {} } = {}) {
  return {
    getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
    getDeviceInfo: () => ({ platform }),
    getStorageSync: (key) => (storage[key] === undefined ? '' : storage[key]),
    setStorageSync: (key, value) => { storage[key] = value },
    removeStorageSync: (key) => { delete storage[key] }
  }
}

/** 每个场景都重新加载模块：config.js 里有些值（如 lan-host）在模块加载时就读了 */
function loadConfig(wxStub) {
  const target = require.resolve('../../Treyni/utils/config')
  delete require.cache[target]
  global.wx = wxStub
  return require(target)
}

const PROD = 'https://api.treyni.cn' // 与 config.js 的 PROD_ORIGIN 保持一致

// 1) 开发者工具
const devtools = loadConfig(makeWx({ platform: 'devtools' }))
check('开发者工具走 127.0.0.1', devtools.getBaseUrl(), 'http://127.0.0.1:3000')
check('开发者工具不是正式版', devtools.isReleaseEnv(), false)

// 2) 真机非正式版：走局域网
const dev = loadConfig(makeWx({ envVersion: 'develop', platform: 'android' }))
check('真机开发版走局域网地址', /^http:\/\/\d+\.\d+\.\d+\.\d+:3000$/.test(dev.getBaseUrl()), true)

// 3) 正式版：只走域名，且忽略缓存里的旧覆盖
const releaseStorage = { debug_baseUrl: 'http://192.168.1.4:3000' }
const release = loadConfig(makeWx({ envVersion: 'release', platform: 'android', storage: releaseStorage }))
check('正式版识别正确', release.isReleaseEnv(), true)
check('正式版走备案域名', release.getBaseUrl(), PROD)
check('正式版忽略历史手动覆盖', release.getOverrideBaseUrl(), 'http://192.168.1.4:3000')
check('正式版候选只有一个', release.getProbeOrder().length, 1)
check('正式版候选就是域名', release.getProbeOrder()[0], PROD)

// 4) 地址规范化：https 不能被补上 :3000
const cfg = loadConfig(makeWx({ platform: 'devtools' }))
check('https 域名不补端口', cfg.normalizeBaseUrl('https://api.tuolaini.com'), 'https://api.tuolaini.com')
check('IPv4 补协议和端口', cfg.normalizeBaseUrl('10.0.0.5'), 'http://10.0.0.5:3000')
check('已写端口不动', cfg.normalizeBaseUrl('http://10.0.0.5:8080'), 'http://10.0.0.5:8080')
check('去掉尾部斜杠', cfg.normalizeBaseUrl('https://api.tuolaini.com/'), 'https://api.tuolaini.com')

console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项')
if (failed) process.exit(1)
