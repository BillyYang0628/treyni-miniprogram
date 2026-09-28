// 实操模拟测试：在微信开发者工具里真实打开页面，验证
// 1) 退出 AI 诊断后植物详情页的每日提醒和养护历程是否已实时更新
// 2) 每日提醒与养护历程内容是否分别生成
// 3) AI 生成期间的预计时长与已等待秒数是否显示
const automator = require('miniprogram-automator')
const { createToken } = require('../../server/src/services/token')
const { argValue, createTempPlant, deletePlant, latestDiagnosisImage } = require('./lib')

const BASE = 'http://127.0.0.1:3000'
// 植物和测试图都改成自动解析：原来写死 PLANT_ID = 6 和某个上传文件名，
// 库清一次 / 上传目录清一次都会失效。
let PLANT_ID = 0
let TEST_IMAGE = ''

let token = ''

async function api(pathname, options = {}) {
  const response = await fetch(BASE + pathname, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  })
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch (e) {
    data = text
  }
  if (!response.ok) {
    throw new Error(pathname + ' -> ' + response.status + ' ' + text.slice(0, 200))
  }
  return data
}

function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  return ok
}

async function main() {
  token = createToken(1)

  // 这个脚本会**写入数据**（生成一次诊断 → 1 条日记 + 2 条提醒），
  // 所以默认跑在临时植物上、结束时整盆删掉（级联清掉日记和提醒）；
  // 想跑在自己的植物上就传 --plant=<id>，但那些记录会留在库里。
  TEST_IMAGE = latestDiagnosisImage()
  if (!TEST_IMAGE) {
    console.error('FAILED: server/data/uploads/diagnosis 下没有可用的测试图')
    process.exit(1)
  }
  const explicitPlant = Number(argValue('plant'))
  const ownPlant = Boolean(explicitPlant)
  PLANT_ID = ownPlant ? explicitPlant : await createTempPlant(token, '诊断走查临时植物', '月季')
  console.log('测试图：' + TEST_IMAGE + '｜植物 id=' + PLANT_ID + (ownPlant ? '（你指定的，记录会保留）' : '（临时造的，结束会删）'))

  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  let failures = 0

  // 进入植物详情
  await miniProgram.reLaunch('/pages/garden/garden')
  await miniProgram.navigateTo('/pages/plant-detail/plant-detail?id=' + PLANT_ID)

  let detailPage = await miniProgram.currentPage()
  await detailPage.waitFor(2500)
  console.log('detail page:', detailPage.path)

  const before = await detailPage.data()
  const beforeReminders = (before.reminders || []).length
  const beforeJournals = (before.journals || []).length
  console.log('进入详情页：待办提醒=' + beforeReminders + '，养护历程=' + beforeJournals)

  // 点开 AI 诊断页
  const aiButtons = await detailPage.$$('.mini-btn-ai')
  await aiButtons[0].tap()
  await detailPage.waitFor(1500)

  let diagnosisPage = await miniProgram.currentPage()
  console.log('diagnosis page:', diagnosisPage.path)
  if (!check('打开 AI 诊断页', diagnosisPage.path, 'pages/diagnosis/diagnosis')) failures++

  // 问题 3：预计时长与已等待秒数
  await diagnosisPage.callMethod('startTimer', '预计 1-3 分钟，请保持页面打开')
  await diagnosisPage.waitFor(3200)
  const timerData = await diagnosisPage.data()
  const elapsedOk = timerData.elapsed >= 3
  console.log((elapsedOk ? 'PASS' : 'FAIL') + ' | 等待计时器 | elapsed=' + timerData.elapsed +
    '，estimate=' + timerData.estimateText)
  if (!elapsedOk) failures++
  if (!check('预计时长文案', timerData.estimateText, '预计 1-3 分钟，请保持页面打开')) failures++

  // 进度条在 wx:if="{{loading}}" 里，光调 startTimer 不会进这个状态，
  // 按项目惯例用 setData 造出"正在生成"的 UI 再看元素（verify-auto-fallback.js 也是这么干的）
  await diagnosisPage.setData({ loading: true })
  await diagnosisPage.waitFor(600)
  const loadingBar = await diagnosisPage.$('.loading-bar-inner')
  console.log((loadingBar ? 'PASS' : 'FAIL') + ' | 进度动画元素存在')
  if (!loadingBar) failures++
  await diagnosisPage.setData({ loading: false })

  // 模拟诊断在诊断页执行完成（AI 报告生成需要 1-2 分钟，这里直接调用后端接口）
  console.log('正在调用后端生成诊断报告（真实 AI 调用，约 1-2 分钟）...')
  const startedAt = Date.now()
  const result = await api('/diagnosis/finalize', {
    method: 'POST',
    body: {
      plant_id: PLANT_ID,
      relative_path: TEST_IMAGE,
      diagnosis: {
        disease: '黑斑病',
        disease_confidence: 0.9,
        severity: 'moderate',
        evidence: '叶片遍布黑色不规则病斑，伴大面积黄化及叶尖枯褐。',
        source: 'baidu+kimi_vision',
        identification: {
          label: '金叶女贞',
          confidence: 0.19436911,
          baike: null,
          note: '百度植物识别的参考结果，仅作参考，本植物的品种以档案为准'
        }
      }
    }
  })
  console.log('诊断耗时 ' + Math.round((Date.now() - startedAt) / 1000) + ' 秒，' +
    '生成 日记#' + result.journal.id +
    ' 提醒#' + result.treatment_reminder.id + '/' + result.feedback_reminder.id)

  await diagnosisPage.callMethod('stopTimer')

  // 问题 1：退出诊断页后，详情页应立刻显示新的提醒和养护历程
  await miniProgram.navigateBack()
  detailPage = await miniProgram.currentPage()
  await detailPage.waitFor(3000)

  const after = await detailPage.data()
  const afterReminders = (after.reminders || []).length
  const afterJournals = (after.journals || []).length
  console.log('返回详情页：待办提醒=' + afterReminders + '，养护历程=' + afterJournals)

  if (!check('返回后待办提醒自动刷新 (+2)', afterReminders, beforeReminders + 2)) failures++
  if (!check('返回后养护历程自动刷新 (+1)', afterJournals, beforeJournals + 1)) failures++

  const renderedReminders = await detailPage.$$('.reminder-item')
  const renderedJournals = await detailPage.$$('.journal-item')
  console.log('页面真实渲染：提醒条目=' + renderedReminders.length + '，历程条目=' + renderedJournals.length)
  if (!check('提醒列表已渲染新条目', renderedReminders.length > 0, true)) failures++
  if (!check('养护历程已渲染新条目', renderedJournals.length > 0, true)) failures++

  // 问题 2：每日提醒 = 打药方案，养护历程 = 病害介绍
  const newestReminder = (after.reminders || []).find((item) => item.id === result.treatment_reminder.id)
  const reminderContent = newestReminder ? newestReminder.content : ''
  const journalContent = result.journal.content || ''

  console.log('\n---- 每日提醒内容（节选）----\n' + reminderContent.slice(0, 200))
  console.log('\n---- 养护历程内容（节选）----\n' + journalContent.slice(0, 200))

  if (!check('提醒内容含用药方案', /稀释|倍液|药剂/.test(reminderContent), true)) failures++
  if (!check('养护历程不含打药流程', /稀释|倍液/.test(journalContent), false)) failures++
  if (!check('两段内容不相同', reminderContent !== journalContent, true)) failures++

  const journalIds = (after.journals || []).map((item) => item.id)
  console.log('详情页已包含新养护历程 id=' + result.journal.id + ': ' + journalIds.includes(result.journal.id))

  console.log('\n清理本次测试数据...')
  if (ownPlant) {
    // 用真实植物跑的时候只删这次生成的三条（提醒有删除接口，日记没有，留在历程里）
    await api('/reminders/' + result.treatment_reminder.id, { method: 'DELETE' }).catch(() => {})
    await api('/reminders/' + result.feedback_reminder.id, { method: 'DELETE' }).catch(() => {})
    console.log('已删掉这次生成的两条提醒；日记 id=' + result.journal.id + ' 保留在养护历程里（没有删除接口）')
  } else {
    await deletePlant(token, PLANT_ID)
    console.log('已删除临时植物 id=' + PLANT_ID + '（日记与提醒一并清掉）')
  }

  console.log('\n' + (failures === 0 ? '全部检查通过' : failures + ' 项检查未通过'))
  await miniProgram.close()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('E2E FAILED:', err && err.message)
  process.exit(1)
})
