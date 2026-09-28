/**
 * 转发功能验证（2026-09-21，品牌素材接入）
 *
 * 要验四件事：
 *   ① 三个页面**真的定义了** onShareAppMessage —— 微信规则是：页面没有这个函数，
 *      右上角菜单里的「转发」就是灰色不可点的。图做得再好，没这一步也白搭。
 *   ② 返回值字段对：标题平实（不过 30 字、无感叹号）、path 落到对应页面且带真实 id、
 *      imageUrl 指向包内封面。
 *   ②b 朋友圈（onShareTimeline）也定义了，而且字段是 **query 不是 path**、不带前导 ?
 *      —— 这条最容易抄错：直接复制 onShareAppMessage 的返回值会静默失效。
 *   ③ 封面文件真的在包里，且**真的是 PNG**（不是 WebP；真机解码器不认 VP8X，踩过一次）。
 *   ④ 打进包的体积没超 2MB（主包上限）。
 *
 * 用法：需要后端 + 开发者工具自动化端口(9420)。node verify-share.js
 */
const fs = require('node:fs')
const path = require('node:path')
const automator = require('miniprogram-automator')
const { getToken, openDb, resolvePlantId, findReminderId, deletePlant } = require('./lib')

const TREYNI = path.resolve(__dirname, '../../Treyni')
const COVER = '/assets/brand/share-cover.png'
const PACK_LIMIT = 2 * 1024 * 1024

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (!ok) failures++
  return ok
}
function checkTruthy(label, actual, extra) {
  const ok = Boolean(actual)
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | ' + (ok ? '命中' : '没命中') +
    (extra ? ' | ' + extra : ''))
  if (!ok) failures++
  return ok
}

/** 打进包的体积（排除 packOptions.ignore 里的文件） */
function packedBytes() {
  const config = require(path.join(TREYNI, 'project.config.json'))
  const ignored = new Set(((config.packOptions && config.packOptions.ignore) || [])
    .map((item) => item.value))
  const walk = (dir, out) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const rel = path.relative(TREYNI, full).replace(/\\/g, '/')
      if (entry.isDirectory()) walk(full, out)
      else out.push({ rel, size: fs.statSync(full).size })
    }
    return out
  }
  return walk(TREYNI, []).filter((item) => !ignored.has(item.rel))
    .reduce((sum, item) => sum + item.size, 0)
}

function fileHeader(file, length) {
  const fd = fs.openSync(file, 'r')
  const buffer = Buffer.alloc(length)
  fs.readSync(fd, buffer, 0, length, 0)
  fs.closeSync(fd)
  return buffer
}

async function shareOf(page) {
  // 直接调页面方法，拿到真实的返回值（不是读代码猜的）
  return page.callMethod('onShareAppMessage')
}

async function timelineOf(page) {
  return page.callMethod('onShareTimeline')
}

/** 朋友圈那条的公共断言 */
function auditTimeline(label, share) {
  checkTruthy('[' + label + '] 定义了 onShareTimeline', share && share.title)
  check('[' + label + '] 封面用的是包内品牌图', share.imageUrl, COVER)
  check('[' + label + '] 没有误用 path 字段（朋友圈只有 query）', share.path, undefined)
  check('[' + label + '] query 不带前导问号', String(share.query || '').indexOf('?'), -1)
}

async function main() {
  const token = getToken()
  const db = openDb()
  const picked = await resolvePlantId(token, { db })
  const plantId = picked.id
  const reminderId = findReminderId(db, { plantId, types: ['watering', 'fertilizing', 'pesticide', 'pruning'] })
  db.close()
  if (!reminderId) throw new Error('没找到可用的养护提醒，先跑一次 detail-pages.js')

  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })

  try {
    console.log('=== ① 我的花园（pages/garden）===')
    await miniProgram.reLaunch('/pages/garden/garden')
    let page = await miniProgram.currentPage()
    await page.waitFor(2500)
    let share = await shareOf(page)
    console.log('  ' + JSON.stringify(share))
    checkTruthy('定义了 onShareAppMessage', share && share.title)
    check('路径是花园页', share.path, '/pages/garden/garden')
    check('封面用的是包内品牌图', share.imageUrl, COVER)
    checkTruthy('标题平实（≤30 字、无感叹号）',
      share.title.length <= 30 && share.title.indexOf('！') < 0, '标题=' + share.title)
    let timeline = await timelineOf(page)
    console.log('  朋友圈：' + JSON.stringify(timeline))
    auditTimeline('garden', timeline)
    check('朋友圈不带参数（花园页本身没有 id）', timeline.query, undefined)

    console.log('')
    console.log('=== ② 植物详情（分享这一盆）===')
    await miniProgram.navigateTo('/pages/plant-detail/plant-detail?id=' + plantId)
    page = await miniProgram.currentPage()
    await page.waitFor(2500)
    share = await shareOf(page)
    console.log('  ' + JSON.stringify(share))
    checkTruthy('定义了 onShareAppMessage', share && share.title)
    check('路径带上真实 id', share.path, '/pages/plant-detail/plant-detail?id=' + plantId)
    check('封面用的是包内品牌图', share.imageUrl, COVER)
    const plantName = (await page.data('plant') || {}).name || ''
    checkTruthy('标题里带了这盆植物的名字', plantName && share.title.indexOf(plantName) >= 0,
      '标题=' + share.title)
    timeline = await timelineOf(page)
    console.log('  朋友圈：' + JSON.stringify(timeline))
    auditTimeline('plant-detail', timeline)
    check('朋友圈 query 带上真实 id', timeline.query, 'id=' + plantId)

    console.log('')
    console.log('=== ③ 提醒详情（分享单条方案）===')
    await miniProgram.reLaunch('/pages/garden/garden')
    await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + reminderId)
    page = await miniProgram.currentPage()
    await page.waitFor(2500)
    share = await shareOf(page)
    console.log('  ' + JSON.stringify(share))
    checkTruthy('定义了 onShareAppMessage', share && share.title)
    check('路径带上真实 id', share.path, '/pages/reminder-detail/reminder-detail?id=' + reminderId)
    check('封面用的是包内品牌图', share.imageUrl, COVER)
    timeline = await timelineOf(page)
    console.log('  朋友圈：' + JSON.stringify(timeline))
    auditTimeline('reminder-detail', timeline)
    check('朋友圈 query 带上真实 id', timeline.query, 'id=' + reminderId)

    console.log('')
    console.log('=== ④ 封面素材本身 ===')
    const coverFile = path.join(TREYNI, COVER.replace(/^\//, ''))
    checkTruthy('封面文件在包里：' + COVER, fs.existsSync(coverFile))
    if (fs.existsSync(coverFile)) {
      // PNG 头 8 字节是签名，宽高在 16/20（各 4 字节）——所以要读 24
      const header = fileHeader(coverFile, 24)
      const isPng = header.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      const isWebp = header.slice(0, 4).toString('ascii') === 'RIFF'
      check('是真正的 PNG（不是 WebP）', isPng && !isWebp, true)
      const size = fs.statSync(coverFile).size
      console.log('  封面 ' + Math.round(size / 1024) + 'KB')
      checkTruthy('封面在 80KB 预算内', size <= 80 * 1024)

      // 5:4：微信转发卡片就是这个比例
      const width = header.readUInt32BE(16)
      const height = header.readUInt32BE(20)
      check('比例是 5:4（' + width + '×' + height + '）', Math.abs(width / height - 1.25) < 0.01, true)
    }

    console.log('')
    console.log('=== ⑤ 主包体积 ===')
    const packed = packedBytes()
    console.log('  打进包 ' + (packed / 1024 / 1024).toFixed(3) + ' MB / 上限 2 MB')
    checkTruthy('没有超出主包上限', packed < PACK_LIMIT)
  } finally {
    if (picked.temp) await deletePlant(token, plantId).catch(() => {})
    await miniProgram.close().catch(() => {})
  }

  console.log('')
  console.log(failures === 0 ? '全部通过' : failures + ' 项未通过')
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error('FAILED: ' + ((err && err.stack) || err))
  process.exit(1)
})
