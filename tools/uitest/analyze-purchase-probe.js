/**
 * 把 taobao-probe.js 抓到的首屏标题过一遍，按问题分类，用来改购买建议。
 *
 * 判据只看首屏标题里的信号词，不逐条点详情页；目的是"找出哪些词/哪些条目的建议需要改"，
 * 不是给每个商品定性。
 *
 * 用法：node analyze-purchase-probe.js
 */
const fs = require('node:fs')
const path = require('node:path')

const GEN = path.resolve(__dirname, '../gen')
const PROBE = JSON.parse(fs.readFileSync(path.join(GEN, 'taobao-probe.json'), 'utf8'))
const TERMS = JSON.parse(fs.readFileSync(path.join(GEN, 'purchase-terms.json'), 'utf8'))

// 首屏标题里的信号词
const SIGNALS = {
  大包装: /\b\d{2,}\s*(kg|KG|千克|公斤|斤)\b|100斤|50斤|25Kg|20kg|10kg/i,
  卫生杀虫: /气雾剂|蟑螂|蚊子|蚊香|电蚊|苍蝇药|杀虫喷雾|灭蚊/,
  非农资混入: /护手霜|除藻|泳池|消毒液|洗衣|洗手液|杀虫喷雾/,
  组合装: /组合|套装|多号|1号2号|2号3号|十全大补/,
  小包装正面信号: /\d{2,4}\s*(g|克|ml|毫升)\b|小包装|试用|家庭装(?!100)/
}

/** 关键词 → 这条结果属于词表里的哪些条目 */
function rowsFor(query) {
  return TERMS.filter((row) => row.search === query)
}

function main() {
  const byQuery = new Map(PROBE.results.map((item) => [item.query, item]))
  const problems = []
  const ok = []

  for (const row of TERMS) {
    const query = row.name.indexOf('专用肥') >= 0 ? '月季专用肥' : row.search
    const result = byQuery.get(query)
    if (!result) {
      problems.push({ ...row, query, issue: '没跑到（词表里没有对应结果）' })
      continue
    }

    const titles = result.items || []
    const flags = {}
    for (const [name, re] of Object.entries(SIGNALS)) {
      const hitCount = titles.filter((title) => re.test(title)).length
      if (hitCount) flags[name] = hitCount
    }

    const record = { ...row, query, verdict: result.verdict, count: result.count, flags, titles }
    if (!titles.length) {
      problems.push({ ...record, issue: '首屏没抓到商品' })
    } else if (flags['非农资混入'] || flags['卫生杀虫']) {
      problems.push({ ...record, issue: '混进非农资/卫生用品' })
    } else if (flags['大包装'] && !flags['小包装正面信号']) {
      problems.push({ ...record, issue: '首屏几乎都是大包装' })
    } else if (flags['大包装']) {
      problems.push({ ...record, issue: '有大包装，但也有小包装' })
    } else {
      ok.push(record)
    }
  }

  console.log('=== 需要改建议的（' + problems.length + '）===')
  for (const item of problems) {
    console.log('[' + item.group + '] ' + item.name + '  ←「' + item.query + '」  ' + item.issue +
      '（首屏 ' + (item.count || 0) + ' 条）')
    console.log('    标志：' + JSON.stringify(item.flags || {}))
    ;(item.titles || []).slice(0, 3).forEach((title) => console.log('      · ' + title.slice(0, 80)))
  }

  console.log('')
  console.log('=== 没问题的（' + ok.length + '）===')
  ok.forEach((item) => console.log('  [' + item.group + '] ' + item.name))

  fs.writeFileSync(path.join(GEN, 'purchase-probe-analysis.json'),
    JSON.stringify({ problems, ok }, null, 1), 'utf8')
  console.log('')
  console.log('分析写到 tools/gen/purchase-probe-analysis.json')
}

main()
