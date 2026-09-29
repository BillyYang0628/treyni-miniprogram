// AI 每日额度的回归：计数从埋点恢复、到点拒绝、归零放行。
// 用临时埋点文件，不碰生产数据，也不调用任何 AI。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

let passed = 0
let failed = 0

function check(label, actual, expected) {
  const ok = String(actual) === String(expected)
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (ok) passed += 1
  else failed += 1
}

const TZ_OFFSET_HOURS = 8

/** 造一个"今天"的埋点行（北京时间当天） */
function todayLine() {
  return JSON.stringify({ ts: new Date().toISOString(), label: 'test', ok: true })
}

function makeMetricsFile(lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'treyni-budget-')), 'ai_metrics.jsonl')
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  return file
}

function freshBudget({ file, limit }) {
  process.env.AI_METRICS_FILE = file
  if (limit === undefined) delete process.env.AI_DAILY_CALL_LIMIT
  else process.env.AI_DAILY_CALL_LIMIT = String(limit)

  const target = require.resolve('../../server/src/services/aiBudget')
  delete require.cache[target]
  return require(target)
}

// 1) 从埋点恢复当天已用次数
const file2 = makeMetricsFile([todayLine(), todayLine()])
const b5 = freshBudget({ file: file2, limit: 5 })
check('从埋点恢复当天计数', b5.status().used, 2)
check('未到上限时放行', b5.check().allowed, true)

// 2) 记录之后计数递增
b5.record()
check('记录后计数递增', b5.status().used, 3)

// 3) 到上限就拒绝，并给出可读原因
const file3 = makeMetricsFile([todayLine(), todayLine(), todayLine()])
const b3 = freshBudget({ file: file3, limit: 3 })
const verdict = b3.check()
check('到上限后拒绝', verdict.allowed, false)
check('拒绝信息可读', /额度已用完/.test(verdict.message || ''), true)
check('拒绝信息带用量', /3\/3/.test(verdict.message || ''), true)

// 4) 昨天的不算今天的
const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
const fileOld = makeMetricsFile([JSON.stringify({ ts: yesterday, label: 'test' }), todayLine()])
const bOld = freshBudget({ file: fileOld, limit: 5 })
check('昨天的不计入今天', bOld.status().used, 1)

// 5) 0 = 不限量
const fileMany = makeMetricsFile(new Array(10).fill(0).map(todayLine))
const bUnlimited = freshBudget({ file: fileMany, limit: 0 })
check('0 表示不限量', bUnlimited.check().allowed, true)
check('不限量标记正确', bUnlimited.status().unlimited, true)

// 6) 默认上限
const bDefault = freshBudget({ file: makeMetricsFile([todayLine()]) })
check('默认上限 400', bDefault.status().limit, 400)

delete process.env.AI_METRICS_FILE
delete process.env.AI_DAILY_CALL_LIMIT

console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项')
if (failed) process.exit(1)
