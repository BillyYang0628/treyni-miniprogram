const config = require('./config')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { ensureDatabase } = require('./db')
const app = require('./app')
const waterScheduler = require('./services/waterScheduler')
const reminderPush = require('./services/reminderPush')

/**
 * 兜底日志：后台任务（定时重算、订阅消息扫描）里的异常不会让进程悄悄退出，
 * 至少要在日志里留下痕迹，方便定位"服务为什么会消失"。
 */
function installCrashGuards() {
  process.on('unhandledRejection', (reason) => {
    console.error('[server] 未处理的 Promise 异常：', reason && reason.stack ? reason.stack : reason)
  })

  process.on('uncaughtException', (err) => {
    console.error('[server] 未捕获异常：', err && err.stack ? err.stack : err)
  })
}

/**
 * 列出本机可作为局域网地址的 IPv4。
 *
 * 过滤掉回环和 169.254 开头的链路本地地址（没拿到 DHCP 时系统自己分的，
 * 手机根本连不上），虚拟网卡（VPN 之类）排到后面但保留——
 * 有时候真机确实是通过虚拟网卡连上的，全藏起来反而不好排查。
 */
function lanAddresses() {
  const virtualAdapter = /vpn|radmin|virtual|vmware|virtualbox|hyper-v|蓝牙|本地连接 \*/i
  const result = []

  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family !== 'IPv4' || net.internal) continue
      if (String(net.address).indexOf('169.254.') === 0) continue
      result.push({ name, address: net.address })
    }
  }

  result.sort((a, b) => Number(virtualAdapter.test(a.name)) - Number(virtualAdapter.test(b.name)))
  return result
}

/**
 * 把当前的局域网地址写进小程序源码里的一个生成文件。
 *
 * 背景：真机上的小程序发现不了电脑的 IP，以前只能在 config.js 里写死一个，
 * 换网络（这台机器三天里换过 10.11.21.3 / 192.168.55.176 / 192.168.1.4）就得人工改。
 * 后端启动时顺手写一份，小程序优先读它——"启动后端"这个动作本身就把地址同步了。
 *
 * 内容没变就不写，否则每次启动都碰文件，会一直触发开发者工具的文件监听。
 */
function syncLanHostToMiniProgram(lan) {
  // 生产环境（PUBLIC_BASE_URL 是 https 域名）不做局域网同步：
  // 服务器上既没有小程序源码目录，把 10.x 内网地址写给小程序也没有意义。
  if (/^https:\/\//i.test(config.publicBaseUrl)) return

  const virtualAdapter = /vpn|radmin|virtual|vmware|蓝牙|本地连接 \*/i
  const primary = lan.find((item) => !virtualAdapter.test(item.name)) || lan[0]
  if (!primary) return

  const target = path.resolve(__dirname, '../../Treyni/utils/lan-host.generated.js')
  const hostLine = "  host: '" + primary.address + "',"

  try {
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
    if (existing.indexOf(hostLine) !== -1) return

    const body = [
      '// 这个文件由后端启动时自动生成，不要手改。',
      '// 生成逻辑：server/src/server.js 的 syncLanHostToMiniProgram()',
      '// 用途：告诉小程序这台电脑当前的局域网地址（真机调试用）。',
      'module.exports = {',
      hostLine,
      "  adapter: '" + String(primary.name).replace(/'/g, '') + "',",
      "  generatedAt: '" + new Date().toISOString() + "'",
      '}',
      ''
    ].join('\n')

    fs.writeFileSync(target, body, 'utf8')
    console.log(`已同步局域网地址到小程序: ${primary.address} [${primary.name}]`)
  } catch (err) {
    // 写不进去不影响后端本身，小程序那边会退化到 config.js 里的候选列表
    console.warn('同步局域网地址失败（不影响后端运行）：' + err.message)
  }
}

function start() {
  installCrashGuards()
  ensureDatabase()

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`托蕾妮小程序后端已启动: http://0.0.0.0:${config.port}`)
    // 以前这里把上一台网络的 IP 写死了，换网络后会打印一个连不上的地址，
    // 真机 request fail 时反而被这条日志带偏。改成实时枚举。
    const lan = lanAddresses()
    if (lan.length) {
      console.log(`局域网访问地址（真机调试用；已自动同步给小程序，不用手填）:`)
      for (const item of lan) {
        console.log(`  http://${item.address}:${config.port}   [${item.name}]`)
      }
      syncLanHostToMiniProgram(lan)
    } else {
      console.log(`局域网访问地址: 没找到可用的局域网 IPv4（手机连不上，请检查网络）`)
    }
    console.log(`数据库路径: ${config.dbPath}`)
    waterScheduler.start()
    reminderPush.start()
  })

  const shutdown = () => {
    server.close(() => {
      process.exit(0)
    })
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

start()
