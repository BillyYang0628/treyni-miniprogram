// 期 1：AI 文本的分段 + 重点识别（纯函数单测，不用开发者工具）。
// 这类"改完看不出对错"的逻辑必须有断言兜着。
const path = require('node:path')
const { splitParagraphs, buildBlocks, MAX_HIGHLIGHT } = require(path.resolve(__dirname, '../../Treyni/utils/aiText.js'))

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 实际=' + actual + ' 期望=' + expected)
  if (!ok) failures++
  return ok
}
function checkTruthy(label, actual) {
  const ok = Boolean(actual)
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | ' + (ok ? '命中' : '没命中'))
  if (!ok) failures++
  return ok
}

/** 把切出来的块拼回一整串，用来确认"没丢字" */
function flatten(blocks) {
  return blocks.map((b) => b.segs.map((s) => s.text).join('')).join('')
}

/** 比"没丢字"时把所有空白去掉再比——分段本来就会吃掉段落之间的换行符 */
function stripWs(text) {
  return String(text || '').replace(/\s+/g, '')
}

function countClass(blocks, cls) {
  let n = 0
  blocks.forEach((b) => b.segs.forEach((s) => { if (s.cls === cls) n++ }))
  return n
}

async function main() {
  console.log('=== ① 正常有换行的文本 ===')
  const withBreaks = '先说结论：这盆不用施肥。\n\n①缓苗期还没过，施肥容易烧根。\n\n②等 10 月 2 日之后再看新叶。'
  const b1 = buildBlocks(withBreaks)
  check('切成 3 段', b1.length, 3)
  check('没有丢字', stripWs(flatten(b1)), stripWs(withBreaks))
  checkTruthy('结论句被高亮', countClass(b1, 'ai-warn') >= 1)

  console.log('')
  console.log('=== ② 模型没换行、400 多字一坨（本次问题的本体）===')
  // 真实那次是 400 多字；这里凑到 200 字以上才会触发"按编号硬切"的兜底
  const blob = '病害介绍：' + '①黑斑病是月季最常见的病，叶子上会出现黑色圆斑，梅雨季节最容易发生。' +
    '②白粉病会在叶片正反面长出白色粉末，通风不好、昼夜温差大的时候最容易出现。' +
    '③锈病先在叶背出现橙色小点，之后会变成褐色粉末，秋天比较常见。' +
    '④红蜘蛛喜欢干燥闷热的环境，叶子会先发白再发黄，叶背能看到细丝。' +
    '⑤平时要通风、别淋头水，发现病叶及时摘掉并清理盆面落叶。'
  check('原始文本只有一段', splitParagraphs('甲。乙。').length, 1)
  checkTruthy('样例够长（≥120 字）才轮到兜底逻辑', blob.length > 120)
  const b2 = buildBlocks(blob)
  console.log('  ' + blob.length + ' 字切成了 ' + b2.length + ' 段')
  checkTruthy('被切成多段（不再是一坨）', b2.length > 1)
  check('没有丢字', stripWs(flatten(b2)), stripWs(blob))

  console.log('')
  console.log('=== ③ 连编号都没有的长文本 ===')
  const noNumber = '这段文本没有任何编号。'.repeat(20)
  const b3 = buildBlocks(noNumber)
  checkTruthy('按句号硬切成了多段', b3.length > 1)
  check('没有丢字', stripWs(flatten(b3)), stripWs(noNumber))

  console.log('')
  console.log('=== ④ 安全警示与关键剂量 ===')
  const b4 = buildBlocks('①切记不要中午喷药，容易药害。\n\n②用苯醚甲环唑3000倍液，1 克药兑 3 升水。\n\n③打完药洗手。')
  checkTruthy('安全句识别到了', countClass(b4, 'ai-warn') >= 1)
  checkTruthy('剂量句识别到了', countClass(b4, 'ai-strong') >= 1)
  const warnSeg = b4.flatMap((b) => b.segs).find((s) => s.cls === 'ai-warn')
  console.log('  被标红的那句：' + (warnSeg ? warnSeg.text.trim() : '(无)'))

  console.log('')
  console.log('=== ⑤ 高亮总数有上限（满屏红 = 没重点）===')
  const many = Array.from({ length: 20 }, (_, i) => '第' + (i + 1) + '条：切记不要这样做。').join('\n\n')
  const b5 = buildBlocks(many)
  const total = countClass(b5, 'ai-warn') + countClass(b5, 'ai-strong')
  console.log('  20 句警示，实际高亮了 ' + total + ' 处')
  check('高亮不超过上限', total <= MAX_HIGHLIGHT, true)
  check('上限值是 5', MAX_HIGHLIGHT, 5)

  console.log('')
  console.log('=== ⑥ 边界 ===')
  check('空文本返回空', buildBlocks('').length, 0)
  check('null 不炸', buildBlocks(null).length, 0)
  check('纯空白返回空', buildBlocks('   \n  ').length, 0)
  const one = buildBlocks('就一句话。')
  check('一句话也是一段', one.length, 1)
  check('没丢字', stripWs(flatten(one)), '就一句话。')

  console.log('')
  console.log('=== ⑦ 安全优先于剂量（长方案里的真问题）===')
  // 实测一条 887 字的打药方案：剂量句排在前面，把 5 个高亮额度全吃掉了，
  // 后面那句「切记」反而没轮上 → 界面上一个红字都没有。
  const longPlan = [
    '①用代森锰锌1000倍液，10天一次。',
    '②也可以用硫磺悬浮剂500倍，10天一次。',
    '③还可以用三唑酮1500倍，7天一次。',
    '④红蜘蛛用阿维菌素2000倍，3天一次。',
    '⑤切记不要把三种药混在一起用。'
  ].join('\n\n')
  const b7 = buildBlocks(longPlan)
  const warns = b7.flatMap((b) => b.segs).filter((s) => s.cls === 'ai-warn')
  console.log('  标红的句子：' + warns.map((s) => s.text.trim()).join(' / '))
  checkTruthy('四句剂量排在前，安全句仍然标红', warns.length > 0)
  checkTruthy('标红的就是那句"切记"', warns.some((s) => s.text.indexOf('切记') >= 0))
  const total7 = warns.length + b7.flatMap((b) => b.segs).filter((s) => s.cls === 'ai-strong').length
  check('总数仍未超上限', total7 <= MAX_HIGHLIGHT, true)

  console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项未通过')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
