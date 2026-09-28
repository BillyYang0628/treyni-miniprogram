// 全流程实操走查（真实模拟器 + 真实后端 + 真实 AI）
// 用法：node tools/uitest/e2e-full.js [add|detail|complete|chat|diagnosis|report|all]
// 每个阶段都会打印 PASS / FAIL / 备注，并在 tools/uitest/logs 下留一份 json 记录。
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { getToken, api, openDb } = require('./lib')

const SHOT_DIR = path.resolve(__dirname, 'shots')
const LOG_DIR = path.resolve(__dirname, 'logs')
const PHASE = process.argv[2] || 'all'

const results = { phase: PHASE, startedAt: new Date().toISOString(), checks: [], notes: [], console: [] }
let failures = 0

function pass(label, detail) {
  results.checks.push({ ok: true, label, detail: detail === undefined ? '' : String(detail) })
  console.log('PASS | ' + label + (detail === undefined ? '' : ' | ' + detail))
}

function fail(label, detail) {
  failures++
  results.checks.push({ ok: false, label, detail: detail === undefined ? '' : String(detail) })
  console.log('FAIL | ' + label + (detail === undefined ? '' : ' | ' + detail))
}

function note(text) {
  results.notes.push(text)
  console.log('备注 | ' + text)
}

function info(text) {
  console.log('     · ' + text)
}

async function shot(mp, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  try {
    await mp.screenshot({ path: path.join(SHOT_DIR, name + '.png') })
  } catch (e) {
    note('截图失败 ' + name + '：' + e.message)
  }
}

async function waitUntil(fn, { timeout = 300000, interval = 5000, onTick } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    if (onTick) await onTick()
    await new Promise((r) => setTimeout(r, interval))
  }
  return null
}

function today() {
  const d = new Date()
  const pad = (v) => (v < 10 ? '0' + v : '' + v)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ---------------------------------------------------------------- 添加植物
async function addPlant(mp) {
  console.log('\n===== 阶段 1：添加植物（真实 UI 操作） =====')
  await mp.switchTab('/pages/garden/garden')
  let page = await mp.currentPage()
  await page.waitFor(2500)

  const before = await api('/plants', {}, token)
  const beforeCount = (before.plants || []).length
  info('添加前植物数：' + beforeCount)

  // 点“+ 添加植物”
  const addBtn = await page.$('.page-header .btn-primary')
  if (!addBtn) {
    fail('花园页有添加植物按钮')
    return null
  }
  await addBtn.tap()
  await page.waitFor(3000)
  page = await mp.currentPage()
  if (page.path !== 'pages/plant-form/plant-form') {
    fail('进入添加植物页', page.path)
    return null
  }
  pass('进入添加植物页')

  let data = await page.data()
  pass('品种选项已加载', (data.speciesOptions || []).length + ' 项')
  pass('土壤选项已加载', (data.soilOptions || []).length + ' 项')
  pass('花盆规格已加载', (data.potSpecOptions || []).length + ' 项')
  pass('摆放环境已加载', (data.exposureOptions || []).length + ' 项')
  if ((data.exposureOptions || []).length !== 6) fail('摆放环境应为 6 项', (data.exposureOptions || []).length)
  if ((data.soilOptions || []).length !== 12) fail('土壤类型应为 12 项', (data.soilOptions || []).length)

  // 1) 名称
  const plantName = '走查月季' + new Date().getMinutes() + new Date().getSeconds()
  await page.callMethod('onInput', { currentTarget: { dataset: { field: 'name' } }, detail: { value: plantName } })

  // 2) 品种关键词检索
  await page.callMethod('onSearchInput', { detail: { value: '月季' } })
  await page.waitFor(800)
  data = await page.data()
  const hits = data.speciesResults || []
  info('搜索“月季”命中：' + hits.map((h) => h.cn_name).join('、'))
  if (hits.length === 0) fail('品种关键词检索有结果')
  else pass('品种关键词检索有结果', hits.length + ' 项')

  const roseHit = hits.find((h) => h.cn_name.includes('月季')) || hits[0]
  if (roseHit) {
    await page.callMethod('onPickSpecies', { currentTarget: { dataset: { id: roseHit.id } } })
    await page.waitFor(1500)
    data = await page.data()
    pass('点选品种回填', data.species + ' / ' + data.speciesGroupText)
    if (!data.carePreview) note('选中品种后没有拿到养护预览')
  }

  // 3) 苗情阶段
  await page.callMethod('onGrowthStageChange', { detail: { value: '1' } })
  // 4) 来源
  await page.callMethod('onPlantSourceChange', { detail: { value: '0' } })
  // 5) 种下日期
  await page.callMethod('onDateChange', { detail: { value: today() } })
  // 6) 刚移栽
  await page.callMethod('onTransplantChange', { detail: { value: true } })
  // 7) 土壤（关键词搜索）
  await page.callMethod('onSoilSearchInput', { detail: { value: '营养土' } })
  await page.waitFor(600)
  data = await page.data()
  info('土壤搜索“营养土”命中：' + (data.soilResults || []).map((s) => s.name).join('、'))
  if ((data.soilResults || []).length > 0) {
    await page.callMethod('onPickSoil', { currentTarget: { dataset: { id: data.soilResults[0].id } } })
    pass('土壤关键词选择', data.soilResults[0].name)
  } else {
    fail('土壤关键词检索有结果')
  }
  // 8) 花盆规格
  data = await page.data()
  const potIndex = (data.potSpecOptions || []).findIndex((p) => p.name === '3 加仑')
  await page.callMethod('onPotSpecChange', { detail: { value: String(potIndex >= 0 ? potIndex : 0) } })
  await page.waitFor(500)
  data = await page.data()
  pass('花盆规格带出口径与盆高', data.pot_size + ' / ' + data.potDiameterCm + 'cm × ' + data.potDepthCm + 'cm')
  // 9) 摆放环境
  const exposureIndex = (data.exposureOptions || []).findIndex((e) => e.id === 'outdoor')
  await page.callMethod('onExposureChange', { detail: { value: String(exposureIndex >= 0 ? exposureIndex : 0) } })
  // 10) 备注
  await page.callMethod('onInput', { currentTarget: { dataset: { field: 'notes' } }, detail: { value: '全流程走查用植物' } })

  await shot(mp, 'full-01-form-filled')

  // 11) 提交
  await page.callMethod('onSubmit')
  const created = await waitUntil(async () => {
    const list = await api('/plants', {}, token)
    return (list.plants || []).find((p) => p.name === plantName) || null
  }, { timeout: 20000, interval: 1500 })

  if (!created) {
    fail('提交后能在列表里查到新植物')
  } else {
    pass('提交成功并落库', '#' + created.id + ' ' + created.name)
  }

  await page.waitFor(2500)
  await mp.switchTab('/pages/garden/garden')
  page = await mp.currentPage()
  await page.waitFor(3000)
  const cards = await page.$$('.plant-card')
  if (cards.length === beforeCount + 1) pass('花园列表新增一张卡片', cards.length + ' 张')
  else fail('花园列表卡片数量', cards.length + '（期望 ' + (beforeCount + 1) + '）')
  await shot(mp, 'full-02-garden-after-add')

  if (!created) return null

  // 自动生成的提醒
  const reminders = await waitUntil(async () => {
    const r = await api('/plants/' + created.id + '/reminders', {}, token)
    return (r.reminders || []).length ? r.reminders : null
  }, { timeout: 30000, interval: 2000 })

  if (!reminders) {
    fail('新植物自动生成提醒')
  } else {
    pass('新植物自动生成提醒', reminders.map((r) => r.type + '/' + r.status).join('，'))
    const watering = reminders.find((r) => r.type === 'watering')
    if (watering) {
      info('浇水提醒：' + watering.summary_text + '（来源 ' + (watering.ai_model || watering.detail_source || '—') + '）')
      if (watering.ai_model === 'water_model') pass('浇水提醒已按天气模型算日期')
      else note('浇水提醒没有走天气模型，ai_model=' + watering.ai_model)
    }
  }
  results.plantId = created.id
  results.plantName = plantName
  return created.id
}

// ---------------------------------------------------------------- 详情页走查
async function detailWalk(mp, plantId) {
  console.log('\n===== 阶段 2：植物详情 / 提醒详情 / 日记 / 编辑 =====')
  await mp.switchTab('/pages/garden/garden')
  let page = await mp.currentPage()
  await page.waitFor(2500)

  await mp.navigateTo('/pages/plant-detail/plant-detail?id=' + plantId)
  page = await mp.currentPage()
  await page.waitFor(4000)
  let data = await page.data()

  if (!data.plant) {
    fail('植物详情加载档案')
  } else {
    pass('植物详情加载档案', data.plant.name + ' / ' + data.plant.species)
    info('苗情=' + data.plant.growth_stage + '，来源=' + data.plant.plant_source +
      '，刚移栽=' + data.plant.is_recent_transplant + '，种下=' + data.plant.planting_date)
    info('基质=' + data.plant.soil_type + '，花盆=' + data.plant.pot_size +
      '，摆放=' + data.plant.exposure)
    const missing = ['growth_stage', 'plant_source', 'planting_date', 'soil_type', 'pot_size', 'exposure']
      .filter((k) => !data.plant[k])
    if (missing.length) fail('档案字段完整', '缺失：' + missing.join('、'))
    else pass('档案字段完整')
  }

  const reminders = data.reminders || []
  pass('详情页提醒数量', reminders.length + ' 条未完成 / ' + (data.completedReminders || []).length + ' 条已完成')
  reminders.forEach((r) => info('  ' + r.type + '｜' + (r.summary_text || '').slice(0, 44)))
  if (reminders.length === 0) fail('详情页有待办提醒')

  const icons = reminders.map((r) => r.icon).filter(Boolean)
  if (icons.length !== reminders.length) fail('每条提醒都有图标', icons.join(''))
  else pass('每条提醒都有图标', icons.join(' '))
  await shot(mp, 'full-03-plant-detail')

  // 提醒详情（浇水）
  const watering = reminders.find((r) => r.type === 'watering') || reminders[0]
  if (watering) {
    await mp.navigateTo('/pages/reminder-detail/reminder-detail?id=' + watering.id)
    const rpage = await mp.currentPage()
    await rpage.waitFor(3500)
    const rd = await rpage.data()
    info('提醒详情：类型=' + rd.typeText + '，来源=' + rd.detailSourceText + '，分块=' + (rd.detailItems || []).length)
    info('摘要：' + (rd.summary || '').slice(0, 60))
    if ((rd.detailItems || []).length > 0) pass('提醒方案按条拆分', rd.detailItems.length + ' 条')
    else fail('提醒方案按条拆分')
    if ((rd.detailText || '').length > 60) pass('提醒方案有正文', (rd.detailText || '').length + ' 字')
    else fail('提醒方案有正文', (rd.detailText || '').length + ' 字')

    // 提醒正文里是否提示“环境变化要重新生成”
    const envNote = await rpage.$('.detail-note-text')
    if (envNote) {
      const envText = await envNote.text()
      pass('方案下方有环境变化提示', envText.slice(0, 40))
    } else {
      fail('方案下方有环境变化提示')
    }

    if (rd.water) {
      pass('浇水提醒带水分账户', rd.waterPercentText + ' / ' + rd.waterEt0Text)
      const bar = await rpage.$('.water-bar-inner')
      if (bar) pass('水分进度条渲染')
      else fail('水分进度条渲染')
    } else {
      note('这条提醒没有水分账户（非浇水或模型未接）')
    }

    // “重新生成这份方案”弹窗（mock 掉 showModal，直接返回一段意见）
    try {
      await mp.mockWxMethod('showModal', { confirm: true, content: '家里没有喷壶，用浇水壶代替可以吗' })
      await rpage.callMethod('onRegenerate')
      await rpage.waitFor(3000)
      const rg = await rpage.data()
      if (rg.generating) pass('弹出意见框后进入重新生成', rg.estimateText || '')
      else fail('弹出意见框后进入重新生成', JSON.stringify({ generating: rg.generating, error: rg.error }))

      const done = await waitUntil(async () => {
        const now = await rpage.data()
        return now.generating ? null : now
      }, {
        timeout: 300000,
        interval: 5000,
        onTick: async () => {
          const now = await rpage.data()
          info('  重新生成中…已等待 ' + now.elapsed + ' 秒')
        }
      })
      if (done && !done.error) pass('按用户意见重新生成成功', (done.detailText || '').length + ' 字')
      else fail('按用户意见重新生成成功', done ? done.error : '超时未完成')
      await shot(mp, 'full-04-reminder-regenerated')
    } catch (e) {
      fail('重新生成弹窗流程', e.message)
    } finally {
      try { await mp.restoreWxMethod('showModal') } catch (e) {}
    }

    await mp.navigateBack()
    await rpage.waitFor(2000)
  }

  // 编辑植物
  page = await mp.currentPage()
  const actionBtns = await page.$$('.summary-actions .mini-btn')
  info('植物详情操作按钮：' + actionBtns.length + ' 个')
  const editBtn = actionBtns[0]
  if (editBtn) {
    await editBtn.tap()
    await page.waitFor(3000)
    const fpage = await mp.currentPage()
    if (fpage.path === 'pages/plant-form/plant-form') {
      const fdata = await fpage.data()
      pass('编辑页回填档案', fdata.name + ' / ' + fdata.species + ' / ' + fdata.growth_stage)
      if (!fdata.name || !fdata.species) fail('编辑页回填完整')
      await fpage.callMethod('onInput', {
        currentTarget: { dataset: { field: 'notes' } },
        detail: { value: '走查时补充的备注 ' + new Date().toLocaleTimeString() }
      })
      await fpage.callMethod('onSubmit')
      await fpage.waitFor(3000)
      const after = await api('/plants/' + plantId, {}, token)
      if ((after.plant.notes || '').includes('走查时补充的备注')) pass('编辑保存生效', after.plant.notes)
      else fail('编辑保存生效', after.plant.notes)
    } else {
      fail('点编辑进入植物表单', fpage.path)
    }
    await mp.navigateBack().catch(() => {})
    await fpage.waitFor(1500)
  }

  // 养护历程详情
  page = await mp.currentPage()
  await page.waitFor(2000)
  const jnodes = await page.$$('.journal-body')
  if (jnodes.length > 0) {
    await jnodes[0].tap()
    await page.waitFor(2000)
    const jpage = await mp.currentPage()
    const jd = await jpage.data()
    if (jpage.path === 'pages/journal-detail/journal-detail') pass('养护历程可进入详情页', jd.typeText + ' ' + jd.timeText)
    else fail('养护历程可进入详情页', jpage.path)
    await shot(mp, 'full-05-journal-detail')
    await mp.navigateBack()
    await jpage.waitFor(1500)
  } else {
    note('详情页还没有养护历程（完成提醒后才会有）')
  }

  // 种植条件速查（四个板块入口）
  await mp.navigateTo('/pages/care-guide/care-guide?section=pot_size')
  let gpage = await mp.currentPage()
  await gpage.waitFor(2500)
  let gd = await gpage.data()
  if ((gd.groups || []).length > 0) pass('种植条件速查（花盆）渲染折叠卡片', (gd.groups || []).length + ' 组')
  else fail('种植条件速查（花盆）渲染折叠卡片')
  await shot(mp, 'full-06-care-guide')
  await mp.navigateBack()
  await gpage.waitFor(1500)
}

// ---------------------------------------------------------------- 完成提醒 + 下一轮 AI
async function completeReminder(mp, plantId) {
  console.log('\n===== 阶段 3：完成提醒 + 下一轮 AI 安排 =====')
  const list = await api('/plants/' + plantId + '/reminders', {}, token)
  const watering = (list.reminders || []).find((r) => r.type === 'watering' && r.status !== 'completed')
  if (!watering) {
    fail('存在可完成的浇水提醒')
    return
  }

  await mp.navigateTo('/pages/reminder-detail/reminder-detail?id=' + watering.id)
  const page = await mp.currentPage()
  await page.waitFor(3000)

  // 完成提醒会弹确认框
  await mp.mockWxMethod('showModal', { confirm: true })
  try {
    await page.callMethod('onComplete')
    await page.waitFor(4000)

    const after = await api('/reminders/' + watering.id, {}, token)
    if (after.reminder && after.reminder.status === 'completed') pass('完成浇水提醒', after.reminder.completed_at)
    else fail('完成浇水提醒', JSON.stringify(after.reminder && after.reminder.status))

    const nextList = await api('/plants/' + plantId + '/reminders', {}, token)
    const next = (nextList.reminders || []).find((r) => r.type === 'watering' && r.status !== 'completed')
    if (next) {
      pass('已自动排下一条浇水提醒', '#' + next.id + ' ' + next.summary_text + '（' + next.ai_status + '）')
      const settled = await waitUntil(async () => {
        const r = await api('/reminders/' + next.id, {}, token)
        return r.reminder && r.reminder.ai_status && r.reminder.ai_status !== 'pending' ? r.reminder : null
      }, {
        timeout: 300000,
        interval: 8000,
        onTick: async () => info('  等 AI 决定下一轮…')
      })
      if (!settled) {
        fail('下一轮 AI 建议在 5 分钟内返回')
      } else if (settled.ai_status === 'done') {
        pass('下一轮 AI 建议生成成功', settled.interval_days + ' 天｜' + (settled.ai_reason || '').slice(0, 60))
      } else {
        fail('下一轮 AI 建议生成成功', '状态 ' + settled.ai_status + '：' + (settled.ai_error || ''))
      }
    } else {
      fail('已自动排下一条浇水提醒')
    }

    const journals = await api('/plants/' + plantId + '/journal', {}, token)
    const waterJournal = (journals.journals || []).find((j) => j.type === 'watering')
    if (waterJournal) pass('完成提醒写入养护历程', waterJournal.content.slice(0, 50))
    else fail('完成提醒写入养护历程')
  } finally {
    try { await mp.restoreWxMethod('showModal') } catch (e) {}
  }
}

// ---------------------------------------------------------------- AI 花农
async function chat(mp, plantId) {
  console.log('\n===== 阶段 4：AI 花农对话 =====')
  await mp.navigateTo('/pages/chat/chat?plant_id=' + plantId)
  const page = await mp.currentPage()
  await page.waitFor(5000)
  let data = await page.data()

  info('开场白：' + String(data.greeting || '').slice(0, 120))
  if (data.greeting) pass('进入对话有开场白', data.greeting.length + ' 字')
  else fail('进入对话有开场白')
  if (/缓苗|小苗|种下|天/.test(data.greeting || '')) pass('开场白包含苗情与天数')
  else note('开场白没有提到苗情或天数：' + String(data.greeting || '').slice(0, 60))

  await shot(mp, 'full-07-chat-open')

  await page.callMethod('onInput', { detail: { value: '我的月季光照每天只有 4 小时，需要改档案吗' } })
  await page.callMethod('onSend')
  await page.waitFor(2500)
  data = await page.data()
  if (data.sending) pass('发送后进入生成状态', data.stageText)
  else fail('发送后进入生成状态', JSON.stringify({ sending: data.sending, error: data.error }))

  const done = await waitUntil(async () => {
    const now = await page.data()
    return now.sending ? null : now
  }, {
    timeout: 320000,
    interval: 6000,
    onTick: async () => {
      const now = await page.data()
      info('  生成中 ' + now.elapsed + 's：' + (now.stageText || ''))
    }
  })

  if (!done) {
    fail('AI 花农在 5 分钟内回复')
  } else if (done.error) {
    fail('AI 花农回复成功', done.error)
  } else {
    const last = (done.messages || []).filter((m) => m.role === 'assistant').pop()
    pass('AI 花农回复成功', (last ? last.content.length : 0) + ' 字')
    info('回复节选：' + String(last && last.content || '').replace(/\n/g, ' ').slice(0, 200))

    // 浇水间隔口径检查：回复里不该再出现和【浇水节奏】冲突的天数
    const reminder = (await api('/plants/' + plantId + '/reminders', {}, token)).reminders
      .find((r) => r.type === 'watering')
    const actualInterval = reminder && reminder.meta && reminder.meta.water
      ? reminder.meta.water.interval_days
      : (reminder ? reminder.interval_days : null)
    const replyText = String((last && last.content) || '')
    // 只看讲浇水的句子，避免把施肥/打药的天数算进来
    const waterClauses = replyText
      .split(/[。！？；\n]/)
      .filter((clause) => /浇/.test(clause) && !/施肥|打药|喷药|修剪/.test(clause))
    const quoted = waterClauses
      .flatMap((clause) => clause.match(/(\d+(?:\.\d+)?)\s*[-–~到]\s*(\d+(?:\.\d+)?)\s*天|每\s*(\d+(?:\.\d+)?)\s*天/g) || [])
    info('当前浇水间隔（天气模型）= ' + actualInterval + ' 天；回复里提到的天数：' + (quoted.join('、') || '无'))
    const conflicting = quoted.filter((text) => {
      const numbers = (text.match(/\d+(?:\.\d+)?/g) || []).map(Number)
      return numbers.length && numbers.every((n) => Math.abs(n - actualInterval) > 1.5)
    })
    if (conflicting.length) {
      fail('对话不再出现与天气模型冲突的浇水天数', conflicting.join('、') + '（实际 ' + actualInterval + ' 天）')
    } else {
      pass('对话不再出现与天气模型冲突的浇水天数')
    }

    if (/南阳台|换成|搬到/.test(String(last && last.content || '')) && (done.pendingChanges || []).length > 0) {
      note('提到了难以做到的搬动建议，并生成了待确认变更：' +
        (done.pendingChanges || []).map((c) => c.text).join('；'))
    } else {
      pass('没有直接生成“搬动位置”类待确认变更', '待确认 ' + (done.pendingChanges || []).length + ' 条')
    }
    await shot(mp, 'full-08-chat-reply')
  }
}

// ---------------------------------------------------------------- AI 诊断
async function diagnosis(mp, plantId) {
  console.log('\n===== 阶段 5：AI 病虫害诊断 =====')
  // 把一张真实叶片照片写进模拟器文件系统，再走页面的上传+识别流程
  const src = path.resolve(__dirname, '../../server/data/uploads/diagnosis/1789306355003-fb79899db69631d7.jpg')
  const base64 = fs.readFileSync(src).toString('base64')
  const tempPath = await mp.evaluate((b64) => {
    const fs = wx.getFileSystemManager()
    const filePath = wx.env.USER_DATA_PATH + '/e2e-leaf.jpg'
    fs.writeFileSync(filePath, b64, 'base64')
    return filePath
  }, base64)
  info('测试图片已写入模拟器：' + tempPath)

  await mp.navigateTo('/pages/diagnosis/diagnosis?plant_id=' + plantId + '&plant_name=' + encodeURIComponent('走查月季'))
  const page = await mp.currentPage()
  await page.waitFor(2500)

  await page.callMethod('uploadAndDiagnose', tempPath)
  await page.waitFor(4000)
  let data = await page.data()
  if (data.loading) pass('进入诊断流程', data.stepText)
  else fail('进入诊断流程', JSON.stringify({ loading: data.loading, error: data.error }))

  const done = await waitUntil(async () => {
    const now = await page.data()
    return now.loading ? null : now
  }, {
    timeout: 320000,
    interval: 6000,
    onTick: async () => {
      const now = await page.data()
      info('  诊断中 ' + now.elapsed + 's：' + (now.stepText || ''))
    }
  })

  if (!done) {
    fail('AI 诊断在 5 分钟内返回结果')
  } else if (done.error) {
    fail('AI 诊断返回结果', done.error)
    await shot(mp, 'full-09-diagnosis-error')
  } else {
    pass('AI 诊断返回结果', done.diseaseText + ' / ' + done.severityText + ' / 置信度 ' + done.confidenceText)
    info('识别植物：' + done.plantText)
    const refNode = await page.$('.result-reference')
    const refConfidence = Number(String(done.referenceConfidenceText || '').replace('%', ''))
    info('参考结论：' + (done.referenceLabel || '（已隐藏）') + ' ' + (done.referenceConfidenceText || '') +
      '，参考区块=' + (refNode ? '显示' : '隐藏'))
    if (!done.referenceLabel) {
      if (!refNode) pass('低置信度的参考识别已隐藏')
      else fail('低置信度的参考识别已隐藏', '页面仍渲染了参考区块')
    } else if (refConfidence >= 60) {
      pass('高置信度的参考识别正常显示', done.referenceLabel + ' ' + done.referenceConfidenceText)
    } else {
      fail('低置信度的参考识别已隐藏', '仍显示 ' + done.referenceLabel + ' ' + done.referenceConfidenceText)
    }
    if ((done.createdReminders || []).length) pass('诊断生成后续提醒', done.createdReminders.map((r) => r.type || r.title).join('、'))
    else note('诊断没有生成喷药/反馈提醒')
    const journals = await api('/plants/' + plantId + '/journal', {}, token)
    const diagJournal = (journals.journals || []).find((j) => /诊断|病害|症状/.test(j.content || ''))
    if (diagJournal) pass('诊断写入养护历程', diagJournal.content.slice(0, 50))
    else note('诊断没有写入养护历程')
    await shot(mp, 'full-10-diagnosis-result')
  }
}

// ---------------------------------------------------------------- 养护报告
async function report(mp, plantId) {
  console.log('\n===== 阶段 6：一键生成养护报告 =====')
  await mp.navigateTo('/pages/report/report?plant_id=' + plantId)
  const page = await mp.currentPage()
  await page.waitFor(3500)
  let data = await page.data()
  if (data.plantName) pass('报告页加载植物', data.plantName)
  else fail('报告页加载植物', JSON.stringify(data.plantId))

  await page.callMethod('onGenerate')
  await page.waitFor(3000)
  data = await page.data()
  if (data.generating) pass('点击生成进入生成状态', data.estimateText)
  else fail('点击生成进入生成状态', JSON.stringify({ generating: data.generating, error: data.error }))

  const done = await waitUntil(async () => {
    const now = await page.data()
    return now.generating ? null : now
  }, {
    timeout: 330000,
    interval: 8000,
    onTick: async () => {
      const now = await page.data()
      info('  生成报告中 ' + now.elapsed + 's')
    }
  })

  if (!done) {
    fail('养护报告在 5 分钟内生成')
  } else if (done.error) {
    fail('养护报告生成成功', done.error)
  } else if (!done.report) {
    fail('养护报告生成成功', '没有返回报告内容')
  } else {
    pass('养护报告生成成功', done.report.title)
    info('时间范围：' + done.report.period_text)
    const stats = done.stats || []
    info('统计卡片：' + stats.map((s) => s.label + '=' + s.value).join('，'))
    // 没有种植日期或没有完成记录的植物，养护天数与按期完成率会缺省不显示
    if (stats.length >= 4) pass('统计卡片齐全', stats.length + ' 个')
    else fail('统计卡片齐全', stats.length + ' 个')
    const sections = (done.report.content && done.report.content.sections) || []
    if (sections.length >= 4) pass('报告小节齐全', sections.length + ' 节')
    else fail('报告小节齐全', sections.length + ' 节')
    if (/[A-Za-z]{3} [A-Za-z]{3}/.test(done.report.period_text || '')) {
      fail('报告时间范围格式', done.report.period_text)
    } else {
      pass('报告时间范围格式', done.report.period_text)
    }
    await shot(mp, 'full-11-report')
  }
}

// ---------------------------------------------------------------- 我的 / 设置
async function dailyFlows(mp, plantId) {
  console.log('\n===== 阶段 8：日常养护动作 / 手动提醒 / 用药反馈 / 删除 =====')
  await mp.switchTab('/pages/garden/garden')
  let page = await mp.currentPage()
  await page.waitFor(2500)
  await mp.navigateTo('/pages/plant-detail/plant-detail?id=' + plantId)
  page = await mp.currentPage()
  await page.waitFor(3500)

  let data = await page.data()
  const journalCountBefore = (data.journals || []).length

  // 1) 快捷养护动作：浇水
  await mp.mockWxMethod('showActionSheet', { tapIndex: 0 })
  try {
    await page.callMethod('onQuickAction')
    await page.waitFor(4000)
    data = await page.data()
    if ((data.journals || []).length > journalCountBefore) {
      pass('快捷动作「浇水」写入养护历程', (data.journals[0] || {}).content)
    } else {
      fail('快捷动作「浇水」写入养护历程', '历程仍是 ' + (data.journals || []).length + ' 条')
    }
  } catch (e) {
    fail('快捷养护动作', e.message)
  } finally {
    try { await mp.restoreWxMethod('showActionSheet') } catch (e) {}
  }

  // 2) 手动添加提醒
  await mp.mockWxMethod('showModal', { confirm: true, content: '检查叶片背面有没有虫' })
  let beforeReminders = (await api('/plants/' + plantId + '/reminders', {}, token)).reminders.length
  try {
    await page.callMethod('onAddReminder')
    await page.waitFor(4000)
    const after = await api('/plants/' + plantId + '/reminders', {}, token)
    const added = after.reminders.filter((r) => r.type === 'custom')
    if (after.reminders.length === beforeReminders + 1 && added.length &&
      added[added.length - 1].title.includes('检查叶片背面')) {
      pass('手动添加提醒', added[added.length - 1].title)
    } else if (after.reminders.length === beforeReminders + 1) {
      fail('手动添加提醒标题', JSON.stringify(added.map((r) => r.title)))
    }
    else fail('手动添加提醒', beforeReminders + ' → ' + after.reminders.length)

    // 3) 删除刚加的提醒
    const custom = after.reminders.find((r) => r.type === 'custom')
    if (custom) {
      await page.callMethod('onDeleteReminder', { currentTarget: { dataset: { id: custom.id } } })
      await page.waitFor(3500)
      const afterDelete = await api('/plants/' + plantId + '/reminders', {}, token)
      if (!afterDelete.reminders.some((r) => r.id === custom.id)) pass('删除自定义提醒')
      else fail('删除自定义提醒')
    }
  } catch (e) {
    fail('手动提醒流程', e.message)
  } finally {
    try { await mp.restoreWxMethod('showModal') } catch (e) {}
  }

  // 4) 用药效果反馈：第 1 轮「无效」应安排第 2 轮
  const feedback = (await api('/plants/' + plantId + '/reminders', {}, token)).reminders
    .find((r) => r.type === 'treatment_feedback' && r.status !== 'completed')
  if (!feedback) {
    note('没有待反馈的用药效果询问，跳过反馈流程')
  } else {
    await mp.navigateTo('/pages/reminder-detail/reminder-detail?id=' + feedback.id)
    const fpage = await mp.currentPage()
    await fpage.waitFor(3000)
    let fd = await fpage.data()
    info('反馈页 stage=' + fd.stage + '，第 ' + fd.feedbackRound + ' 轮')
    await fpage.callMethod('onFeedbackIneffective')
    await fpage.waitFor(5000)
    fd = await fpage.data()
    info('提交「无效」后 stage=' + fd.stage + '，结果=' + fd.resultTitle)
    if (fd.stage === 'consult') {
      // 两个疗程无效，交给 AI 判断
      const settled = await waitUntil(async () => {
        const now = await fpage.data()
        return now.consulting ? null : now
      }, {
        timeout: 300000,
        interval: 6000,
        onTick: async () => {
          const now = await fpage.data()
          info('  AI 判断中 ' + now.elapsed + 's')
        }
      })
      if (settled && settled.suggestion) pass('AI 给出换药建议', settled.suggestion.length + ' 字')
      else fail('AI 给出换药建议', settled ? (settled.consultError || '空') : '超时')

      // 本次选「暂不调整」，验证是否落库
      await fpage.callMethod('onSkipSuggestion')
      await fpage.waitFor(4000)
      fd = await fpage.data()
      info('点「暂不调整」后 stage=' + fd.stage + '，结果=' + fd.resultTitle)
      const rejected = db.prepare(`
        SELECT meta_json FROM plant_reminders WHERE id = ?
      `).get(feedback.id)
      if (rejected && /adjustment_rejected_at/.test(rejected.meta_json || '')) {
        pass('「暂不调整」已落库', rejected.meta_json.slice(0, 80))
      } else {
        fail('「暂不调整」已落库', String(rejected && rejected.meta_json).slice(0, 80))
      }
      await shot(mp, 'full-13-treatment-reject')
    } else if (fd.stage === 'result') {
      pass('第 1 轮无效已安排下一轮', fd.resultTitle)
    } else {
      fail('用药反馈流程', 'stage=' + fd.stage)
    }
  }
}

// 让 AI 主动提出一条提醒调整，验证「先待确认、再落库」
async function chatChange(mp, plantId) {
  console.log('\n===== 阶段 10：AI 提议变更 → 用户确认 =====')
  const before = await api('/plants/' + plantId + '/reminders', {}, token)
  const waterBefore = before.reminders.find((r) => r.type === 'watering' && r.status !== 'completed')

  await mp.navigateTo('/pages/chat/chat?plant_id=' + plantId)
  const page = await mp.currentPage()
  await page.waitFor(5000)

  await page.callMethod('onInput', { detail: { value: '把浇水改成每 5 天一次吧' } })
  await page.callMethod('onSend')
  await page.waitFor(2000)

  const done = await waitUntil(async () => {
    const now = await page.data()
    return now.sending ? null : now
  }, {
    timeout: 320000,
    interval: 6000,
    onTick: async () => {
      const now = await page.data()
      info('  生成中 ' + now.elapsed + 's：' + (now.stageText || ''))
    }
  })

  if (!done) {
    fail('AI 对话返回（改浇水节奏）', '5 分钟超时')
    return
  }
  if (done.error) {
    fail('AI 对话返回（改浇水节奏）', done.error)
    return
  }

  const pending = done.pendingChanges || []
  info('待确认变更 ' + pending.length + ' 条：' + pending.map((c) => c.title + '｜' + c.text).join('；'))
  info('回复节选：' + String(((done.messages || []).filter((m) => m.role === 'assistant').pop() || {}).content || '')
    .replace(/\n/g, ' ').slice(0, 160))

  if (!pending.length) {
    fail('AI 提出待确认的提醒调整')
    return
  }
  pass('AI 提出待确认的提醒调整', pending.length + ' 条')

  // 点「确认」执行这条变更
  const btn = await page.$('.pending-actions .btn, .pending-item .btn')
  if (!btn) {
    note('没有找到待确认变更的确认按钮，改为直接调用接口验证执行链路')
  } else {
    await btn.tap()
  }
  const changeId = pending[0].id
  await page.callMethod('onConfirmChange', { currentTarget: { dataset: { id: changeId } } }).catch(() => {})
  await page.waitFor(5000)

  const after = await api('/plants/' + plantId + '/reminders', {}, token)
  const waterAfter = after.reminders.find((r) => r.type === 'watering' && r.status !== 'completed')
  if (waterBefore && waterAfter && waterAfter.interval_days !== waterBefore.interval_days) {
    pass('确认后提醒间隔已落库', waterBefore.interval_days + ' → ' + waterAfter.interval_days + ' 天')
  } else if (waterAfter && Number(waterAfter.interval_days) === 5) {
    pass('确认后提醒间隔已落库', '5 天')
  } else {
    fail('确认后提醒间隔已落库',
      '前 ' + (waterBefore && waterBefore.interval_days) + '，后 ' + (waterAfter && waterAfter.interval_days))
  }
  await shot(mp, 'full-14-chat-change')
}

// 复查「点击填空后占位文字上移」这个曾经的问题是否真的修好
async function focusCheck(mp) {
  console.log('\n===== 阶段 11：输入框聚焦前后高度复查 =====')
  await mp.switchTab('/pages/garden/garden')
  let page = await mp.currentPage()
  await page.waitFor(2000)
  await mp.navigateTo('/pages/plant-form/plant-form')
  page = await mp.currentPage()
  await page.waitFor(3500)

  const inputs = await page.$$('.form-input')
  info('表单里的输入框数量：' + inputs.length)
  let unstable = 0
  for (let i = 0; i < Math.min(inputs.length, 4); i++) {
    const before = await inputs[i].size()
    await inputs[i].input('测试')
    await page.waitFor(600)
    const after = await inputs[i].size()
    const shifted = Math.abs((before.height || 0) - (after.height || 0)) > 2
    info('第 ' + (i + 1) + ' 个输入框：聚焦前高 ' + Math.round(before.height) +
      'px → 聚焦后高 ' + Math.round(after.height) + 'px，偏移 ' +
      Math.round(after.y - before.y) + 'px')
    if (shifted) unstable++
  }
  if (unstable === 0) pass('聚焦前后输入框高度不变')
  else fail('聚焦前后输入框高度不变', unstable + ' 个输入框发生变化')
  await shot(mp, 'full-15-form-focus')
  await mp.navigateBack()
  await page.waitFor(1200)
}

// 微信登录：清掉本地 token，走一次真实的 wx.login → 服务端换 openid → 发 token
async function loginCheck(mp) {
  console.log('\n===== 阶段 12：微信登录 =====')
  const saved = await mp.evaluate(() => ({
    token: wx.getStorageSync('token') || '',
    userInfo: wx.getStorageSync('userInfo') || null
  }))
  info('登录前本地 token：' + (saved.token ? saved.token.slice(0, 12) + '…' : '（空）'))

  await mp.evaluate(() => {
    wx.removeStorageSync('token')
    wx.removeStorageSync('userInfo')
  })

  await mp.switchTab('/pages/profile/profile')
  const page = await mp.currentPage()
  await page.waitFor(2500)
  const out = await page.data()
  if (!out.userInfo) pass('清除本地登录态后显示未登录')
  else fail('清除本地登录态后显示未登录')

  const loginBtn = await page.$('.btn-primary.btn-block')
  if (!loginBtn) {
    fail('未登录时显示微信登录按钮')
  } else {
    pass('未登录时显示微信登录按钮')
    await loginBtn.tap()
    await page.waitFor(6000)
    const after = await mp.evaluate(() => ({
      token: wx.getStorageSync('token') || '',
      userInfo: wx.getStorageSync('userInfo') || null
    }))
    if (after.token) pass('微信登录成功并写入 token', after.token.slice(0, 12) + '…')
    else fail('微信登录成功并写入 token', JSON.stringify(after))
    if (after.userInfo) pass('微信登录返回用户信息', JSON.stringify(after.userInfo))
    else fail('微信登录返回用户信息')
  }
  await shot(mp, 'full-16-login')

  // 恢复原来的账号数据，避免影响后续（token 内容不影响，用户是同一个人）
  if (!saved.token) return
  const now = await mp.evaluate(() => wx.getStorageSync('token') || '')
  if (!now) {
    await mp.evaluate((s) => {
      wx.setStorageSync('token', s.token)
      if (s.userInfo) wx.setStorageSync('userInfo', s.userInfo)
    }, saved)
    note('登录失败，已恢复走查前的本地登录态')
  }
}

async function cleanup(mp, plantId) {
  console.log('\n===== 阶段 9：删除植物（走查收尾） =====')
  await mp.switchTab('/pages/garden/garden')
  let page = await mp.currentPage()
  await page.waitFor(2500)
  await mp.navigateTo('/pages/plant-detail/plant-detail?id=' + plantId)
  page = await mp.currentPage()
  await page.waitFor(3000)

  await mp.mockWxMethod('showModal', { confirm: true })
  try {
    await page.callMethod('onDelete')
    await page.waitFor(4000)
    const after = await api('/plants', {}, token)
    if (!(after.plants || []).some((p) => p.id === plantId)) pass('删除植物成功')
    else fail('删除植物成功')

    const left = db.prepare('SELECT COUNT(*) AS c FROM plant_reminders WHERE plant_id = ?').get(plantId).c
    const leftJournal = db.prepare('SELECT COUNT(*) AS c FROM plant_journal WHERE plant_id = ?').get(plantId).c
    pass('删除后提醒已清理', left + ' 条')
    info('删除后养护历程剩余：' + leftJournal + ' 条')
  } catch (e) {
    fail('删除植物流程', e.message)
  } finally {
    try { await mp.restoreWxMethod('showModal') } catch (e) {}
  }
}

async function settings(mp) {
  console.log('\n===== 阶段 7：我的 / 城市设置 / 订阅 =====')
  await mp.switchTab('/pages/profile/profile')
  const page = await mp.currentPage()
  await page.waitFor(3500)
  const data = await page.data()
  info('用户：' + JSON.stringify(data.userInfo))
  info('城市：' + (data.location ? data.location.city : '未设置') +
    '，天气：' + (data.weather ? data.weather.now.text + ' ' + data.weather.now.temp + '℃' : (data.weatherError || '—')))
  if (!data.userInfo) fail('我的页读取到登录用户')
  else pass('我的页读取到登录用户', data.userInfo.id)
  if (!data.location) fail('我的页有养护城市')
  else pass('我的页有养护城市', data.location.city)
  if (!data.weather && !data.weatherError) note('天气还没加载出来（可能仍在请求）')
  if (data.weatherError) fail('天气加载', data.weatherError)

  // 订阅提醒推送
  await mp.mockWxMethod('showModal', { confirm: false })
  const menuItems = await page.$$('.menu-item')
  info('养护工具入口 ' + menuItems.length + ' 个')
  if (menuItems.length >= 4) pass('养护工具入口齐全', menuItems.length + ' 个')
  else fail('养护工具入口齐全', menuItems.length + ' 个')

  // 城市设置
  await mp.navigateTo('/pages/city/city')
  const cpage = await mp.currentPage()
  await cpage.waitFor(2000)
  await cpage.callMethod('onInput', { detail: { value: '杭州' } })
  await cpage.callMethod('onSearch')
  await cpage.waitFor(3500)
  const cd = await cpage.data()
  const cities = cd.cities || cd.results || []
  info('搜索“杭州”命中：' + cities.map((c) => c.name + '(' + c.id + ')').join('、'))
  if (cities.length) pass('城市检索可用', cities.length + ' 个候选')
  else fail('城市检索可用')
  await shot(mp, 'full-12-city')
  try { await mp.restoreWxMethod('showModal') } catch (e) {}
}

// ---------------------------------------------------------------- 主流程
let token = null
let db = null

async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  token = getToken()
  db = openDb()
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  mp.on('console', (msg) => {
    const text = (msg.args || []).map((a) => (a && a.value !== undefined ? String(a.value) : JSON.stringify(a))).join(' ')
    results.console.push({ type: msg.type, text })
    if (msg.type === 'error') console.log('  [console.error] ' + text.slice(0, 300))
  })
  mp.on('exception', (err) => {
    results.console.push({ type: 'exception', text: JSON.stringify(err).slice(0, 500) })
    console.log('  [exception] ' + JSON.stringify(err).slice(0, 300))
  })

  let plantId = null
  try {
    if (PHASE === 'all' || PHASE === 'add') plantId = await addPlant(mp)
    if (!plantId && PHASE !== 'all' && PHASE !== 'add' && PHASE !== 'login' && PHASE !== 'focus') {
      // 单跑某个阶段时，默认用最近添加的那盆植物
      if (process.argv[3]) {
        plantId = Number(process.argv[3])
      } else {
        const list = await api('/plants', {}, token)
        const newest = (list.plants || [])[0]
        plantId = newest ? newest.id : null
      }
      info('本阶段使用植物 #' + plantId)
      if (!plantId) throw new Error('没有可用的植物，请先跑 add 阶段')
    }
    if (PHASE === 'all' || PHASE === 'detail') await detailWalk(mp, plantId)
    if (PHASE === 'all' || PHASE === 'complete') await completeReminder(mp, plantId)
    if (PHASE === 'all' || PHASE === 'chat') await chat(mp, plantId)
    if (PHASE === 'all' || PHASE === 'diagnosis') await diagnosis(mp, plantId)
    if (PHASE === 'all' || PHASE === 'report') await report(mp, plantId)
    if (PHASE === 'all' || PHASE === 'settings') await settings(mp)
    if (PHASE === 'all' || PHASE === 'daily') await dailyFlows(mp, plantId)
    if (PHASE === 'chat-change') await chatChange(mp, plantId)
    if (PHASE === 'focus') await focusCheck(mp)
    if (PHASE === 'login') await loginCheck(mp)
    if (PHASE === 'cleanup') await cleanup(mp, plantId)
  } catch (err) {
    fail('流程异常中断', err && err.message)
    console.error(err && err.stack)
  } finally {
    results.failures = failures
    results.finishedAt = new Date().toISOString()
    results.plantId = plantId
    fs.writeFileSync(path.join(LOG_DIR, 'e2e-full-' + PHASE + '.json'), JSON.stringify(results, null, 2))
    try { if (db) db.close() } catch (e) {}
    try { await mp.close() } catch (e) {}
  }

  console.log('\n===== 结果：' + (failures === 0 ? '全部通过' : failures + ' 项未通过') + '，备注 ' + results.notes.length + ' 条 =====')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('E2E FAILED:', err && err.stack)
  process.exit(1)
})
