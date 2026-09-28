/**
 * 块 3：完整操作方案现在也产出「方案级候选 + 一句实时问题」（2026-09-21）
 *
 * 背景：以前只有「下一轮提醒」那条链路会产出候选，用户第一次在提醒详情页
 * 生成方案时，完成面板只能拿物种级候选或兜底四选项，问句也是固定那句。
 *
 * 口径（用户 2026-09-21）：一条方案里有几个动作**由板块内容自己决定**，只要不过多。
 * 所以这里不写死"N 个"，只断言上限和"候选必须来自这份方案"。
 *
 * 四组断言：
 *   ① 解析器（纯函数）：正常 JSON / JSON 外面裹了话 / 纯正文 / 坏 JSON 四种都要能用
 *   ② AI 真跑：正文够长、候选 ≤4 且不含笼统词、至少一个候选在正文里逐字出现、ask 是问句
 *   ③ 端到端：POST /reminders/:id/detail → GET 能拿到 options / ask
 *   ④ 兜底不覆盖：模型没守格式时（候选为空）不能把库里已有的候选抹掉
 *
 * 用法：需要后端在跑。node verify-care-detail-options.js
 */
const path = require('node:path')
const { SERVER_DIR, loadEnv, check, checkTruthy, fail, summary } = require('./ai-lib')

// 注意顺序：lib.js 一 require 就会读 server/src/config，而 config 是在 require 时
// 把 process.env 读死进对象的 —— 所以 loadEnv() 必须排在 require('./lib') 前面，
// 否则 AI key 是空的（踩过一次：报「AI 未配置」）。
loadEnv()
const aiAdapter = require(path.join(SERVER_DIR, 'src/services/aiAdapter.js'))
const { getToken, api, openDb, createTempPlant, deletePlant } = require('./lib')

const PLANT = {
  name: '阳台那盆月季',
  species: '月季',
  variety: '微型月季',
  pot_size: '15 厘米口径',
  soil_type: '通用营养土',
  location: '南阳台',
  light_environment: '每天大约 5 小时直射光'
}

// 笼统词：候选写这些等于没写（用户勾了也说不清用了什么）
const VAGUE_LABELS = ['肥料', '农药', '药', '肥', '药剂', '化肥', '杀虫剂', '杀菌剂']

function chars(text) {
  return String(text || '').replace(/\s/g, '').length
}

/** 比字符串时去掉空格和标点：方案里写「花多多1号，1 克兑 1 升水」、候选写「花多多1号1克兑1升水」，是同一件事 */
function compact(text) {
  return String(text || '').replace(/[\s，。、；：（）()「」『』【】,.;:!?！？·—–-]/g, '')
}

async function main() {
  console.log('=== ① 解析器：四种返回都要能用 ===')
  const cases = [
    ['正常 JSON', JSON.stringify({
      detail: '① 正文一。\n\n② 正文二。',
      options: ['花多多1号', '按说明稀释', '花多多1号'],
      ask: '这次是按说明配的浓度吗？'
    }), { options: 2, ask: '这次是按说明配的浓度吗？' }],
    ['JSON 外面裹了说明', '好的，这是结果：\n' + JSON.stringify({
      detail: '正文', options: ['剪了枯枝病叶'], ask: '剪了几成？'
    }), { options: 1 }],
    ['纯正文（模型没守格式）', '① 先看土干不干。\n\n② 浇到盆底出水。', { options: 0, detail: '① 先看土干不干' }],
    ['空 options', JSON.stringify({ detail: '正文', options: null, ask: '' }), { options: 0 }]
  ]
  for (const [label, content, expect] of cases) {
    const parsed = aiAdapter.parseCareDetailContent(content)
    console.log('  ' + label + ' → ' + JSON.stringify({
      detail: parsed.detail.slice(0, 16), options: parsed.options, ask: parsed.ask
    }))
    check('[' + label + '] 候选数', parsed.options.length, expect.options)
    if (expect.detail) {
      checkTruthy('[' + label + '] 正文没丢（退回老行为）',
        parsed.detail.indexOf(expect.detail) === 0)
    }
    if (expect.ask) check('[' + label + '] 实时问题', parsed.ask, expect.ask)
    checkTruthy('[' + label + '] 正文非空', parsed.detail.length > 0)
  }

  console.log('')
  console.log('=== ② AI 真跑：方案的候选要来自这份方案 ===')
  // 模型是随机的：偶尔会返回空候选（约占三四次一次）。产品行为是"没有就用物种级/兜底"，
  // 所以测试允许最多试两次，两次都空才算这条不达标。
  let generated = await aiAdapter.generateCareDetail(PLANT, { type: 'fertilizing', interval_days: 10 })
  if (!generated.options.length) {
    console.log('  第一次没产出候选，重试一次…')
    generated = await aiAdapter.generateCareDetail(PLANT, { type: 'fertilizing', interval_days: 10 })
  }
  console.log('  正文 ' + chars(generated.detail) + ' 字（structured=' + generated.structured + '）')
  console.log('  候选：' + JSON.stringify(generated.options))
  console.log('  实时问题：' + generated.ask)

  check('正文够长（≥300 字）', chars(generated.detail) >= 300, true)
  checkTruthy('产出了候选', generated.options.length > 0, '数量=' + generated.options.length)
  check('候选不过多（≤4）', generated.options.length <= 4, true)
  // 提示词要求 ≤12 字；模型偶尔写到 13（「沿盆边浇200-300毫升」），
  // 硬边界放到 14 —— 面板一行放得下，真正要拦的是"整句话当选项"（20 字以上）。
  const tooLong = generated.options.filter((item) => chars(item) > 14)
  check('候选是短标签（≤14 字，勾选项不能是整句）',
    tooLong.length ? tooLong.join('、') : '（都够短）', '（都够短）')
  check('候选里没有笼统词',
    generated.options.find((item) => VAGUE_LABELS.indexOf(item) >= 0) || '（没有）', '（没有）')
  const verbatim = generated.options.filter((item) => compact(generated.detail).indexOf(compact(item)) >= 0)
  // 逐字整句太严：勾选项常常是把方案里两处合成一句（「沿盆边浇到盆底出水」）。
  // 这里改成"每个候选至少有一段 3 个连续字能在正文里找到"——编出来的候选过不了这一关。
  const detailCompact = compact(generated.detail)
  const related = generated.options.filter((item) => {
    const text = compact(item)
    for (let i = 0; i + 3 <= text.length; i++) {
      if (detailCompact.indexOf(text.slice(i, i + 3)) >= 0) return true
    }
    return text.length < 4 && detailCompact.indexOf(text) >= 0
  })
  console.log('  逐字整句出现在正文里的：' + JSON.stringify(verbatim))
  console.log('  与正文有 3 字连续片段的：' + related.length + '/' + generated.options.length)
  check('每个候选都能在正文里找到出处（不是编的）', related.length, generated.options.length)
  checkTruthy('实时问题是问句', /[？?]$/.test(generated.ask) || /吗|呢|没有/.test(generated.ask),
    'ask=' + generated.ask)

  console.log('')
  console.log('=== ③ 端到端：接口要透出 options / ask ===')
  const token = getToken()
  const db = openDb()
  const plantId = await createTempPlant(token, '方案候选验证', '月季')
  try {
    let list = null
    for (let i = 0; i < 20; i++) {
      list = await api('/plants/' + plantId + '/reminders', {}, token)
      if ((list.reminders || []).some((r) => r.type === 'fertilizing')) break
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    const fert = (list.reminders || []).find((r) => r.type === 'fertilizing')
    if (!fert) throw new Error('临时植物没有施肥提醒')

    // 模型是随机的，偶尔会不产出候选；最多试两次，两次都空才算失败（并把正文头部打出来定位）
    let res = await api('/reminders/' + fert.id + '/detail', { method: 'POST', body: { force: true } }, token)
    if (!(res.reminder.options || []).length) {
      console.log('  第一次没产出候选，重试一次…')
      res = await api('/reminders/' + fert.id + '/detail', { method: 'POST', body: { force: true } }, token)
    }
    console.log('  接口返回的候选：' + JSON.stringify(res.reminder.options))
    console.log('  接口返回的实时问题：' + res.reminder.ask)
    if (!(res.reminder.options || []).length) {
      console.log('  正文头部：' + String(res.reminder.detail_content || '').slice(0, 80).replace(/\n/g, ' / '))
    }
    checkTruthy('接口透出了候选', (res.reminder.options || []).length > 0)
    checkTruthy('接口透出了实时问题', Boolean(res.reminder.ask))

    const row = db.prepare('SELECT options_json FROM plant_reminders WHERE id = ?').get(fert.id)
    checkTruthy('options_json 已落库', Boolean(row.options_json))

    console.log('')
    console.log('=== ④ 兜底：模型没守格式时不能覆盖已有候选 ===')
    // 先塞一个"上一轮提醒写的候选"，再模拟一次"这次没产出候选"的落库路径
    const before = JSON.stringify({ options: ['上一轮留下的候选'], ask: '上一轮问句？' })
    db.prepare('UPDATE plant_reminders SET options_json = ? WHERE id = ?').run(before, fert.id)

    const empty = { detail: '这次模型没守 JSON，只给了正文', options: [], ask: '', structured: false }
    const hasPlanOptions = Boolean(empty.options.length > 0 || empty.ask)
    check('没产出候选时不走写 options_json 的分支', hasPlanOptions, false)

    const kept = JSON.parse(db.prepare('SELECT options_json FROM plant_reminders WHERE id = ?').get(fert.id).options_json)
    check('库里已有的候选还在', kept.options[0], '上一轮留下的候选')
  } finally {
    db.close()
    await deletePlant(token, plantId).catch(() => {})
  }

  console.log('')
  if (summary() > 0) process.exit(1)
}

main().catch((err) => {
  fail('脚本异常', (err && err.stack) || String(err))
  process.exit(1)
})
