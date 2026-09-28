// 逾期配色的回归断言：天数 → 颜色必须一一对应，7 天封顶。
// 这类纯函数用脚本断言比看截图可靠（色调差一点肉眼分不出来）。
const path = require('node:path')
const { overdueColor, isOverdue, OVERDUE_COLORS } = require(path.resolve(__dirname, '../../Treyni/utils/overdue.js'))

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (!ok) failures++
}

console.log('色阶表：')
OVERDUE_COLORS.forEach((c, i) => console.log('  ' + i + ' 天 -> ' + c))
console.log('')

// 逐档对照
const expected = ['#2d3a2d', '#4a4030', '#5f4530', '#754a30', '#8c4d30', '#a84d33', '#c04a3a', '#e5484d']
for (let day = 0; day <= 7; day++) {
  check(day + ' 天', overdueColor(day), expected[day])
}

// 边界
check('第 0 天就是原来的近黑（不逾期不变色）', overdueColor(0), '#2d3a2d')
check('7 天封顶', overdueColor(7), '#e5484d')
check('12 天不再变深', overdueColor(12), '#e5484d')
check('100 天不再变深', overdueColor(100), '#e5484d')
check('没传值按 0 处理', overdueColor(undefined), '#2d3a2d')
check('0 天不算逾期', isOverdue(0), false)
check('1 天算逾期', isOverdue(1), true)

console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项未通过')
process.exit(failures === 0 ? 0 : 1)
