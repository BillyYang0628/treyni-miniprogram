/**
 * 回归：种植条件数据文件缺失时的降级行为。
 *
 * 背景（2026-10-12 线上实测）：`server/data/planting_options.json` 没被部署脚本推到服务器，
 *   · /knowledge/planting-options 返回空数组 → 添加植物页「摆放环境」是必填却没有可选项，用户卡死；
 *   · waterPlan 里 `findSoil(...)` 返回 null，随后读 `soil.w` 抛
 *     `Cannot read properties of null (reading 'w')`，浇水提醒的 AI 方案全废。
 * 修复后要求：
 *   1) 文件在 → 一切照旧（土壤/环境有值，能算出浇水计划）；
 *   2) 文件缺失 → 不再抛 TypeError，改用内置默认土壤参数继续算（降级但不崩）；
 *   3) 意外内部错误不回显给用户（error 中间件只给一句人话）。
 *
 * 跑法：node 工具/uitest/verify-planting-options-fallback.js
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')

const SERVER = path.resolve(__dirname, '..', '..', 'server')
const TS = () => new Date().toISOString()

let pass = 0
let fail = 0
function check(name, condition, extra) {
  if (condition) {
    pass++
    console.log('  ✅ ' + name + (extra ? '（' + extra + '）' : ''))
  } else {
    fail++
    console.log('  ❌ ' + name + (extra ? '（' + extra + '）' : ''))
  }
}

const SIMULATE = process.argv.includes('--simulate-missing')

if (SIMULATE) {
  // 子进程模式：在模块加载前把 readFileSync 对 planting_options.json 的调用打掉，
  // 模拟"服务器上没这个文件"的场景。
  const realRead = fs.readFileSync
  fs.readFileSync = function (target, ...rest) {
    if (String(target).includes('planting_options.json')) {
      const err = new Error("ENOENT: no such file or directory, open '" + target + "'")
      err.code = 'ENOENT'
      throw err
    }
    return realRead.call(fs, target, ...rest)
  }
}

process.env.DB_PATH = path.join(os.tmpdir(), 'treyni-verify-' + process.pid + '.db')

const waterModel = require(path.join(SERVER, 'src', 'services', 'waterModel'))
const waterPlan = require(path.join(SERVER, 'src', 'services', 'waterPlan'))

const plant = {
  id: 1,
  user_id: 1,
  name: '回归用绿萝',
  species: '绿萝',
  soil_id: 'peat_mix',
  exposure: 'closed_balcony',
  pot_depth_mm: 0
}

async function main() {
  if (process.env.VERIFY_CHILD !== '1') {
    console.log('【1】数据文件存在时的正常路径')
    const soils = waterModel.getSoils()
    const exposures = waterModel.getExposures()
    check('土壤类型有数据', soils.length > 0, 'soil_types=' + soils.length)
    check('摆放环境有数据', exposures.length > 0, 'exposures=' + exposures.length)

    const plan = await waterPlan.computeNextWatering(plant, {})
    check('能算出浇水计划', Boolean(plan && plan.nextDueDate), 'intervalDays=' + (plan && plan.intervalDays))
    check('土壤用的是 peat_mix', String(plan.soil || '').includes('通用营养土'), 'soil=' + plan.soil)

    console.log('【2】模拟"服务器上没有 planting_options.json"')
    try {
      const out = execFileSync(process.execPath, [__filename, '--simulate-missing'], {
        encoding: 'utf8',
        env: Object.assign({}, process.env, { VERIFY_CHILD: '1', NODE_NO_WARNINGS: '1' })
      })
      process.stdout.write(out.split('\n').map((line) => line && '  ' + line).join('\n') + '\n')
      check('缺文件时不再抛 TypeError（子进程正常结束）', true)
    } catch (err) {
      check('缺文件时不再抛 TypeError（子进程正常结束）', false, String(err.stdout || err.message).slice(0, 300))
    }

    console.log('【3】意外内部错误不回显给用户')
    const { errorHandler } = require(path.join(SERVER, 'src', 'middleware', 'error'))
    const captured = {}
    const fakeRes = {
      status(code) { captured.status = code; return this },
      json(body) { captured.body = body; return this }
    }
    const realError = console.error
    console.error = () => {}
    errorHandler(new TypeError("Cannot read properties of null (reading 'w')"), {}, fakeRes)
    console.error = realError
    check('状态码仍是 500', captured.status === 500, 'status=' + captured.status)
    check('文案不含内部报错', captured.body && !/Cannot read|TypeError|null/.test(captured.body.error), captured.body && captured.body.error)

    const okRes = { status(code) { this.code = code; return this }, json(body) { this.body = body; return this } }
    const friendly = new Error('AI 服务暂时不可用，请稍后再试')
    friendly.status = 502
    errorHandler(friendly, {}, okRes)
    check('显式标注过的错误文案照原样返回', okRes.body && okRes.body.error === 'AI 服务暂时不可用，请稍后再试', okRes.body && okRes.body.error)

    console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败（' + TS() + '）')
    process.exit(fail ? 1 : 0)
  }

  // 子进程：只验证"缺文件也不崩"，并把关键值打出来给父进程看
  const soils = waterModel.getSoils()
  console.log('  getSoils() = ' + soils.length + '（预期 0，因为文件被模拟成缺失）')
  console.log('  DEFAULT_SOIL.w = ' + waterModel.DEFAULT_SOIL.w)
  if (soils.length !== 0) throw new Error('模拟失败：土壤列表不为空')
  if (!(waterModel.DEFAULT_SOIL.w > 0)) throw new Error('DEFAULT_SOIL 没有有效的 w')

  const plan = await waterPlan.computeNextWatering(plant, {})
  console.log('  仍然算出计划：due=' + plan.nextDueDate + ' interval=' + plan.intervalDays + ' soil=' + plan.soil)
  if (!plan.nextDueDate) throw new Error('没有算出下一次浇水日期')
  process.exit(0)
}

main().catch((err) => {
  console.error('  ❌ 子进程/主流程失败：' + err.message)
  process.exit(1)
})
