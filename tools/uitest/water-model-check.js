// 天气系数模型验证
// 1) 与《天气系数模型》文档里的三个算例对照
// 2) 降雨重置：露天大雨应当重置浇水基准；封闭阳台同一场雨不应重置
// 3) 基质差异：颗粒土比通用营养土浇得更勤
// 4) 拿不到天气时按季节平均值兜底
const path = require('node:path')
const model = require('../../server/src/services/waterModel')

function check(label, actual, expected, tolerance = 0.01) {
  const ok = tolerance === 0
    ? actual === expected
    : Math.abs(Number(actual) - Number(expected)) <= tolerance
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  return ok
}

function day(offset, options = {}) {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  const pad = (value) => (value < 10 ? '0' + value : '' + value)
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    ...options
  }
}

let failures = 0

console.log('=== 一、文档算例对照 ===')
const case1 = model.computeInterval({ i0: 2.53, et0: 5.78, indoor: false, month: 8, substrateW: 0.30 })
console.log(`算例1 上海 8 月露养月季：W=${case1.w}，间隔=${case1.intervalDays} 天`)
if (!check('算例1 间隔 1.15 天', case1.intervalDays, 1.15)) failures++

const case2 = model.computeInterval({ i0: 3.66, et0: 1.43, indoor: true, month: 1, substrateW: 0.30 })
console.log(`算例2 上海 1 月室内绿萝：W=${case2.w}，间隔=${case2.intervalDays} 天`)
if (!check('算例2 间隔 6.5 天', case2.intervalDays, 6.5, 0.1)) failures++

const case3 = model.computeInterval({ i0: 12.06, et0: 0.30, indoor: true, month: 1, substrateW: 0.30 })
console.log(`算例3 哈尔滨 1 月室内虎尾兰：ET₀采用 ${case3.et0Used}，间隔=${case3.intervalDays} 天`)
if (!check('算例3 间隔 24.3 天', case3.intervalDays, 24.3, 0.1)) failures++
if (!check('算例3 触发室内下限', case3.floorApplied, true, 0)) failures++

console.log('\n=== 二、降雨重置 ===')
// 露天月季：3 加仑盆、通用营养土 → AWC = 235 × 0.30 = 70.5mm
// 今天刚浇过，第二天一场 80mm 暴雨，有效雨量 80mm ≥ AWC → 应视为自然浇透并重置
const outdoorDaily = [
  day(0, { et0: 5.0, rainMm: 0 }),
  day(1, { et0: 3.0, rainMm: 80 }),
  day(2, { et0: 5.5, rainMm: 0 }),
  day(3, { et0: 5.5, rainMm: 0 }),
  day(4, { et0: 5.5, rainMm: 0 }),
  day(5, { et0: 5.5, rainMm: 0 }),
  day(6, { et0: 5.5, rainMm: 0 })
]
const outdoor = model.projectWatering({
  daily: outdoorDaily,
  i0: 2.53,
  indoor: false,
  substrateW: 0.30,
  awcMm: model.availableWater(235, 0.30),
  rainFactor: 1.0
})
console.log('露天月季逐日账户：' + outdoor.steps.map((s) => `${s.date.slice(5)}:${s.tank}`).join(' → '))
console.log('自然浇水日：' + JSON.stringify(outdoor.naturalWateringDays) + '，下次浇水：' + outdoor.nextDueDate)
if (!check('暴雨被识别为自然浇水', outdoor.naturalWateringDays.length, 1, 0)) failures++
if (!check('下次浇水被重置到雨后', outdoor.nextDueDate > outdoor.naturalWateringDays[0], true, 0)) failures++
console.log('参考：没有这场雨时应在 1 天内就该浇水（当天间隔 ' + outdoor.steps[0].intervalDays + ' 天）')

// 封闭阳台同一场雨：只有 15% 淋到，不应重置
const closed = model.projectWatering({
  daily: outdoorDaily,
  i0: 2.53,
  indoor: false,
  substrateW: 0.30,
  awcMm: model.availableWater(235, 0.30),
  rainFactor: 0.15
})
console.log('封闭阳台逐日账户：' + closed.steps.map((s) => `${s.date.slice(5)}:${s.tank}`).join(' → '))
console.log('自然浇水日：' + JSON.stringify(closed.naturalWateringDays) + '，下次浇水：' + closed.nextDueDate)
if (!check('封闭阳台的雨不构成重置', closed.naturalWateringDays.length, 0, 0)) failures++
if (!check('封闭阳台下次浇水更早', closed.nextDueDate <= outdoor.nextDueDate, true, 0)) failures++

console.log('\n=== 三、基质差异（同样天气）===')
const dryWeather = [day(0, { et0: 5.5 }), day(1, { et0: 5.5 }), day(2, { et0: 5.5 }), day(3, { et0: 5.5 })]
const peat = model.projectWatering({
  daily: dryWeather, i0: 7, indoor: true, substrateW: 0.30,
  awcMm: model.availableWater(150, 0.30), rainFactor: 0
})
const grit = model.projectWatering({
  daily: dryWeather, i0: 7, indoor: true, substrateW: 0.20,
  awcMm: model.availableWater(150, 0.20), rainFactor: 0
})
console.log('通用营养土间隔：' + peat.lastStep.intervalDays + ' 天；颗粒土间隔：' + grit.lastStep.intervalDays + ' 天')
if (!check('颗粒土浇得更勤', grit.lastStep.intervalDays < peat.lastStep.intervalDays, true, 0)) failures++

console.log('\n=== 四、拿不到天气时的兜底 ===')
const fallback = model.projectWatering({
  daily: [day(0, {}), day(1, {}), day(2, {})],
  i0: 3,
  indoor: false,
  substrateW: 0.30,
  awcMm: model.availableWater(150, 0.30),
  rainFactor: 0
})
console.log('兜底用的 ET₀ 来源：' + fallback.steps[0].et0Source + '，ET₀=' + fallback.steps[0].et0)
if (!check('走季节兜底', fallback.steps[0].et0Source, 'seasonal', 0)) failures++
const reason = model.describeReason(fallback, { weatherSource: 'seasonal' })
console.log('提示文案：' + reason)
if (!check('提示未获取到天气', reason.includes('没取到当地天气'), true, 0)) failures++

console.log('\n=== 五、选项库 ===')
const soils = model.getSoils()
const pots = model.getPotSpecs()
const exposures = model.getExposures()
console.log('土壤选项 ' + soils.length + ' 种，花盆规格 ' + pots.length + ' 种，摆放环境 ' + exposures.length + ' 种')
if (!check('土壤选项够多', soils.length >= 10, true, 0)) failures++
console.log('关键词找土壤：颗粒土 → ' + (model.findSoil('颗粒土') || {}).name +
  '；泥炭 → ' + (model.findSoil('泥炭') || {}).name +
  '；水苔 → ' + (model.findSoil('水苔') || {}).name)
if (!check('关键词能命中颗粒土', (model.findSoil('颗粒土') || {}).id, 'succulent_grit', 0)) failures++
if (!check('关键词能命中水苔', (model.findSoil('水苔') || {}).id, 'orchid_moss', 0)) failures++
if (!check('加仑能命中 3 加仑', (model.findPotSpec('3加仑') || {}).depth_mm, 235, 0)) failures++

console.log(failures === 0 ? '\n全部检查通过' : '\n' + failures + ' 项检查未通过')
process.exitCode = failures === 0 ? 0 : 1
