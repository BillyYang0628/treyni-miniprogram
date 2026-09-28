// 全流程走查：从登录态开始，把小程序每个页面依次打开一遍，
// 收集渲染结果、控制台报错、异常日志并输出截图，用于汇总当前存在的问题。
// 用法：node tools/uitest/e2e-walk.js
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { getToken, api, openDb } = require('./lib')

const SHOT_DIR = path.resolve(__dirname, 'shots')
const BASE = 'http://127.0.0.1:3000'

const logs = []
const problems = []
const notes = []

function log(line) {
  console.log(line)
}

function problem(scope, detail) {
  problems.push({ scope, detail })
  console.log('  [问题] ' + scope + '：' + detail)
}

function note(scope, detail) {
  notes.push({ scope, detail })
  console.log('  [记录] ' + scope + '：' + detail)
}

function attach(mp, scope) {
  mp.on('console', (msg) => {
    const text = (msg.args || [])
      .map((a) => (a && a.value !== undefined ? String(a.value) : JSON.stringify(a)))
      .join(' ')
    const entry = { scope, type: msg.type, text }
    logs.push(entry)
    if (msg.type === 'error' || msg.type === 'warn') {
      console.log('  [console.' + msg.type + '] ' + text.slice(0, 400))
    }
  })
  mp.on('exception', (err) => {
    logs.push({ scope, type: 'exception', text: JSON.stringify(err).slice(0, 600) })
    console.log('  [exception] ' + JSON.stringify(err).slice(0, 600))
  })
}

async function shot(mp, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  try {
    await mp.screenshot({ path: path.join(SHOT_DIR, name + '.png') })
  } catch (e) {
    note(name, '截图失败：' + e.message)
  }
}

async function safeData(page) {
  try {
    return await page.data()
  } catch (e) {
    return null
  }
}

function summarizeReminder(r) {
  return `#${r.id} ${r.type}/${r.status} ${r.title || ''}`
}

async function main() {
  const token = getToken()
  const db = openDb()
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  attach(mp, 'global')

  const report = { pages: [], api: {}, db: {} }

  // ---------- 0. 登录态 ----------
  log('\n=== 0. 登录态 ===')
  await mp.reLaunch('/pages/garden/garden')
  let page = await mp.currentPage()
  await page.waitFor(2500)

  let storage = null
  try {
    storage = await mp.evaluate(() => {
      return {
        token: wx.getStorageSync('token') || '',
        userInfo: wx.getStorageSync('userInfo') || null
      }
    })
  } catch (e) {
    problem('登录态', '读取本地存储失败：' + e.message)
  }
  if (storage) {
    log('本地 token：' + (storage.token ? storage.token.slice(0, 16) + '…' : '（空）'))
    log('本地 userInfo：' + JSON.stringify(storage.userInfo))
    if (!storage.token) problem('登录态', '本地没有 token，说明当前模拟器未登录')
  }

  try {
    const me = await api('/users/me', {}, token)
    log('接口 /users/me：' + JSON.stringify(me.user || me).slice(0, 200))
    report.api.me = me
  } catch (e) {
    problem('登录态', '/users/me 调用失败：' + e.message)
  }

  // ---------- 1. 我的花园 ----------
  log('\n=== 1. 我的花园 ===')
  let data = await safeData(page)
  if (!data) {
    problem('我的花园', '页面 data 读取失败')
  } else {
    const plants = data.plants || []
    log('loading=' + data.loading + '，植物数=' + plants.length)
    report.pages.push({ page: 'garden', plants: plants.length, loading: data.loading })
    if (data.loading === true) note('我的花园', '等待 2.5 秒后 loading 仍为 true')
    if (plants.length === 0) {
      note('我的花园', '当前账号没有植物，后续列表相关走查会跳过')
    } else {
      plants.slice(0, 10).forEach((p) => log('  - #' + p.id + ' ' + p.name + ' / ' + (p.species || '—') +
        ' / 提醒 ' + (p.reminder_count === undefined ? '—' : p.reminder_count)))
    }
    const cards = await page.$$('.plant-card')
    log('渲染出的植物卡片数：' + cards.length)
    if (plants.length > 0 && cards.length === 0) {
      problem('我的花园', '有植物数据但没有渲染出 .plant-card 卡片')
    }
  }
  await shot(mp, 'walk-01-garden')

  // ---------- 2. 我的 ----------
  log('\n=== 2. 我的 ===')
  await mp.switchTab('/pages/profile/profile')
  page = await mp.currentPage()
  await page.waitFor(3000)
  data = await safeData(page)
  if (!data) {
    problem('我的', '页面 data 读取失败')
  } else {
    log('用户：' + JSON.stringify(data.user || null).slice(0, 160))
    log('养护位置：' + (data.location ? data.location.city : '未设置'))
    log('天气：' + (data.weather ? (data.weather.now.text + ' ' + data.weather.now.temp + '℃') : (data.weatherError || '无')))
    report.pages.push({
      page: 'profile',
      hasUser: Boolean(data.user),
      city: data.location ? data.location.city : null,
      hasWeather: Boolean(data.weather),
      weatherError: data.weatherError || null
    })
    if (!data.user) problem('我的', '未显示用户信息')
    if (!data.location) problem('我的', '未设置养护城市（天气浇水模型会退回知识库间隔）')
    if (data.location && data.weatherError) problem('我的', '已有城市但天气加载失败：' + data.weatherError)
  }
  await shot(mp, 'walk-02-profile')

  // ---------- 3. 城市设置 ----------
  log('\n=== 3. 城市设置 ===')
  await mp.navigateTo('/pages/city/city')
  page = await mp.currentPage()
  await page.waitFor(2000)
  data = await safeData(page)
  if (data) {
    log('当前城市：' + (data.location ? data.location.city : '未设置'))
    report.pages.push({ page: 'city', city: data.location ? data.location.city : null })
  }
  await shot(mp, 'walk-03-city')
  await mp.navigateBack()
  await page.waitFor(1200)

  // ---------- 4. 添加植物页（只看不提交） ----------
  log('\n=== 4. 添加植物页 ===')
  await mp.navigateTo('/pages/plant-form/plant-form')
  page = await mp.currentPage()
  await page.waitFor(3500)
  data = await safeData(page)
  if (!data) {
    problem('添加植物', '页面 data 读取失败')
  } else {
    log('字段：' + Object.keys(data).join(','))
    log('品种选项数：' + ((data.varieties || data.plantOptions || []).length))
    log('土壤选项数：' + ((data.soils || []).length) + '，花盆选项数：' + ((data.pots || []).length) +
      '，摆放选项数：' + ((data.exposures || []).length))
    report.pages.push({
      page: 'plant-form',
      soils: (data.soils || []).length,
      pots: (data.pots || []).length,
      exposures: (data.exposures || []).length
    })
    if ((data.exposures || []).length === 0) problem('添加植物', '摆放环境选项为空')
  }

  // 品种搜索
  try {
    await page.setData({ varietyKeyword: '月季' })
    if (typeof page.callMethod === 'function') await page.callMethod('onVarietyInput', { detail: { value: '月季' } })
    await page.waitFor(1200)
    const after = await safeData(page)
    const hits = (after && (after.varietyMatches || after.varietyResults || [])) || []
    log('搜索“月季”命中：' + hits.length)
    if (hits.length === 0) note('添加植物', '关键词“月季”未命中候选（可能字段名不同，需人工确认）')
  } catch (e) {
    note('添加植物', '品种搜索自动检查失败：' + e.message)
  }
  await shot(mp, 'walk-04-plant-form')
  await mp.navigateBack()
  await page.waitFor(1200)

  // ---------- 5. 植物详情 / 提醒详情 / 养护日记详情 ----------
  const garden = await api('/plants', {}, token)
  const plantList = garden.plants || []
  log('\n=== 5. 植物详情（共 ' + plantList.length + ' 盆） ===')

  if (plantList.length > 0) {
    const target = plantList[0]
    await mp.navigateTo('/pages/plant-detail/plant-detail?id=' + target.id)
    page = await mp.currentPage()
    await page.waitFor(3500)
    data = await safeData(page)
    if (!data) {
      problem('植物详情', '页面 data 读取失败')
    } else {
      const reminders = data.reminders || []
      const journals = data.journals || []
      log('植物：' + (data.plant ? data.plant.name : '—') + '，提醒 ' + reminders.length +
        ' 条，养护历程 ' + journals.length + ' 条，loading=' + data.loading)
      reminders.forEach((r) => log('  - ' + summarizeReminder(r) + ' | ' + (r.summary_text || '').slice(0, 40)))
      report.pages.push({
        page: 'plant-detail',
        plantId: target.id,
        reminders: reminders.length,
        journals: journals.length,
        loading: data.loading
      })

      // 提醒详情
      if (reminders.length > 0) {
        const pendingWater = reminders.find((r) => r.type === 'watering' && r.status === 'pending') || reminders[0]
        await mp.navigateTo('/pages/reminder-detail/reminder-detail?id=' + pendingWater.id)
        let rpage = await mp.currentPage()
        await rpage.waitFor(4000)
        const rd = await safeData(rpage)
        if (!rd) {
          problem('提醒详情', '页面 data 读取失败')
        } else {
          log('提醒 #' + pendingWater.id + '：stage=' + rd.stage + '，generating=' + rd.generating +
            '，来源=' + (rd.detailSourceText || '—'))
          log('摘要：' + (rd.summary || '').slice(0, 60))
          log('详情长度：' + ((rd.detailText || '').length))
          const blocks = rd.blocks || rd.detailBlocks || []
          if (blocks.length) log('分块条数：' + blocks.length)
          if (rd.water) log('水分账户：' + rd.waterPercentText + ' / ' + rd.waterEt0Text)
          if (rd.error) problem('提醒详情', '页面报错：' + JSON.stringify(rd.error).slice(0, 200))
          report.pages.push({
            page: 'reminder-detail',
            reminderId: pendingWater.id,
            stage: rd.stage,
            generating: rd.generating,
            hasWater: Boolean(rd.water),
            error: rd.error || null
          })
        }
        await shot(mp, 'walk-05-reminder-detail')
        await mp.navigateBack()
        await rpage.waitFor(1200)
      }

      // 养护日记详情
      page = await mp.currentPage()
      data = await safeData(page)
      const jrnodes = await page.$$('.journal-body')
      if (jrnodes.length > 0) {
        await jrnodes[0].tap()
        await page.waitFor(2000)
        const jpage = await mp.currentPage()
        const jd = await safeData(jpage)
        log('养护日记详情：' + jpage.path + '，类型=' + (jd && jd.typeText) + '，时间=' + (jd && jd.timeText) +
          '，内容长度=' + ((jd && jd.journal && jd.journal.content) || '').length)
        if (jpage.path !== 'pages/journal-detail/journal-detail') {
          problem('养护日记', '点击养护历程没有进入详情页，实际=' + jpage.path)
        }
        await shot(mp, 'walk-06-journal-detail')
        await mp.navigateBack()
        await jpage.waitFor(1200)
      } else {
        note('养护日记', '植物详情页没有可点击的养护历程条目')
      }

      // 返回花园
      await mp.navigateBack()
      await page.waitFor(1200)
    }
  }

  // ---------- 6. 种植条件速查（四个字段页） ----------
  log('\n=== 6. 种植条件速查 ===')
  for (const kind of ['pot', 'soil', 'position', 'light']) {
    try {
      await mp.navigateTo('/pages/care-guide/care-guide?topic=' + kind)
      const gpage = await mp.currentPage()
      await gpage.waitFor(2200)
      const gd = await safeData(gpage)
      const cards = await gpage.$$('.guide-card')
      log(kind + '：标题=' + (gd && gd.title) + '，卡片=' + cards.length +
        '，展开项=' + (gd && gd.expandedIndex))
      if (!gd || !(gd.sections || []).length) problem('种植条件速查', kind + ' 页没有内容')
      if (cards.length === 0) problem('种植条件速查', kind + ' 页没有渲染出折叠卡片')
      await shot(mp, 'walk-07-care-guide-' + kind)
      await mp.navigateBack()
      await gpage.waitFor(1000)
    } catch (e) {
      problem('种植条件速查', kind + ' 页打开失败：' + e.message)
    }
  }

  // ---------- 7. AI 花农（对话页） ----------
  log('\n=== 7. AI 花农对话 ===')
  if (plantList.length > 0) {
    const p = plantList[0]
    await mp.navigateTo('/pages/chat/chat?plantId=' + p.id)
    page = await mp.currentPage()
    await page.waitFor(6000)
    data = await safeData(page)
    if (!data) {
      problem('AI 花农', '页面 data 读取失败')
    } else {
      log('stage=' + data.stage + '，消息数=' + ((data.messages || []).length))
      const msgs = data.messages || []
      msgs.slice(0, 3).forEach((m) => log('  [' + m.role + '] ' + String(m.content || '').replace(/\n/g, ' ').slice(0, 90)))
      report.pages.push({ page: 'chat', stage: data.stage, messages: msgs.length, error: data.error || null })
      if (data.error) problem('AI 花农', '进入页面即报错：' + JSON.stringify(data.error).slice(0, 200))
      const opening = msgs.find((m) => m.role === 'assistant')
      if (!opening) {
        note('AI 花农', '进入后 6 秒内没有生成开场白，stage=' + data.stage)
      }
    }
    await shot(mp, 'walk-08-chat')
    await mp.navigateBack()
    await page.waitFor(1200)
  }

  // ---------- 8. AI 诊断 ----------
  log('\n=== 8. AI 诊断 ===')
  if (plantList.length > 0) {
    const p = plantList[0]
    await mp.navigateTo('/pages/diagnosis/diagnosis?plantId=' + p.id)
    page = await mp.currentPage()
    await page.waitFor(3000)
    data = await safeData(page)
    if (!data) {
      problem('AI 诊断', '页面 data 读取失败')
    } else {
      log('字段：' + Object.keys(data).join(','))
      log('plantId=' + data.plantId + '，stage=' + (data.stage || data.status))
      if (data.error) problem('AI 诊断', '页面报错：' + JSON.stringify(data.error).slice(0, 200))
      const history = data.history || data.records || []
      log('历史诊断数：' + history.length)
      report.pages.push({ page: 'diagnosis', plantId: data.plantId, history: history.length })
    }
    await shot(mp, 'walk-09-diagnosis')
    await mp.navigateBack()
    await page.waitFor(1200)
  }

  // ---------- 9. 养护报告 ----------
  log('\n=== 9. 养护报告 ===')
  if (plantList.length > 0) {
    const p = plantList[0]
    await mp.navigateTo('/pages/report/report?plantId=' + p.id)
    page = await mp.currentPage()
    await page.waitFor(4000)
    data = await safeData(page)
    if (!data) {
      problem('养护报告', '页面 data 读取失败')
    } else {
      log('字段：' + Object.keys(data).join(','))
      log('plantId=' + data.plantId + '，generating=' + data.generating +
        '，历史报告=' + ((data.reports || []).length))
      if (data.error) problem('养护报告', '页面报错：' + JSON.stringify(data.error).slice(0, 200))
      report.pages.push({
        page: 'report',
        plantId: data.plantId,
        generating: data.generating,
        reports: (data.reports || []).length
      })
    }
    await shot(mp, 'walk-10-report')
    await mp.navigateBack()
    await page.waitFor(1200)
  }

  // ---------- 10. 后端健康与关键接口 ----------
  log('\n=== 10. 后端接口抽查 ===')
  const checks = [
    ['/health', '/health'],
    ['/planting-options', '/knowledge/planting-options'],
    ['/config/subscribe', '/config/subscribe'],
    ['/users/me', '/users/me'],
    ['/users/me/location', '/users/me/location'],
    ['/weather/current', '/weather/current']
  ]
  for (const [label, url] of checks) {
    try {
      const started = Date.now()
      const res = await api(url, {}, token)
      const ms = Date.now() - started
      log(label + ' 正常（' + ms + 'ms）：' + JSON.stringify(res).slice(0, 120))
      report.api[label] = { ok: true, ms }
    } catch (e) {
      problem('后端接口', label + ' 调用失败：' + e.message)
      report.api[label] = { ok: false, error: e.message }
    }
  }

  // ---------- 11. 数据一致性抽查 ----------
  log('\n=== 11. 数据一致性抽查 ===')
  try {
    const reminders = db.prepare(`
      SELECT status, COUNT(*) AS c FROM plant_reminders GROUP BY status
    `).all()
    log('提醒状态分布：' + reminders.map((r) => r.status + '=' + r.c).join('，'))
    report.db.reminderStatus = reminders

    const stale = db.prepare(`
      SELECT COUNT(*) AS c FROM plant_reminders
      WHERE status = 'pending' AND due_at < datetime('now', '-3 day')
    `).get()
    log('已过期超过 3 天仍未完成的提醒：' + stale.c + ' 条')
    report.db.staleReminders = stale.c

    const aiFailed = db.prepare(`
      SELECT COUNT(*) AS c FROM plant_reminders WHERE ai_status = 'failed'
    `).get()
    log('AI 建议生成失败（ai_status=failed）的提醒：' + aiFailed.c + ' 条')
    report.db.aiFailed = aiFailed.c

    const pendingAi = db.prepare(`
      SELECT COUNT(*) AS c FROM plant_reminders WHERE ai_status = 'pending'
    `).get()
    log('仍在等待 AI 生成（ai_status=pending）的提醒：' + pendingAi.c + ' 条')
    report.db.aiPending = pendingAi.c

    const push = db.prepare(`
      SELECT COUNT(*) AS c FROM plant_reminders WHERE meta_json LIKE '%"push_status":"failed"%'
    `).get()
    log('推送失败（push_status=failed）的提醒：' + push.c + ' 条')
    report.db.pushFailed = push.c
  } catch (e) {
    problem('数据一致性', '查询失败：' + e.message)
  }

  db.close()
  await mp.close()

  // ---------- 汇总 ----------
  log('\n=== 汇总 ===')
  log('控制台 warn/error/exception 共 ' + logs.filter((l) => l.type !== 'log').length + ' 条')
  logs.filter((l) => l.type !== 'log').slice(0, 40).forEach((l) => log('  [' + l.type + '] ' + l.text.slice(0, 200)))
  log('问题 ' + problems.length + ' 项，记录 ' + notes.length + ' 项')

  fs.writeFileSync(
    path.resolve(__dirname, 'e2e-walk-report.json'),
    JSON.stringify({ report, problems, notes, logs }, null, 2)
  )
  process.exit(0)
}

main().catch((err) => {
  console.error('WALK FAILED:', err && err.stack)
  process.exit(1)
})
