/**
 * 看每个 AI 场景现在跑的是哪个版本的提示词。
 *
 * 背景：改完提示词之后，"这次输出到底是不是新版本跑的"以前只能靠感觉；
 * ai_metrics.jsonl 现在每条都带 promptHash（只对 system 消息取指纹），
 * 这个脚本把它按 label 汇总出来。
 *
 * 用法：
 *   node prompt-versions.js            # 每个 label 最近一次调用的指纹
 *   node prompt-versions.js --since=2  # 只看最近 2 小时
 */
const fs = require('node:fs')
const path = require('node:path')

const FILE = path.resolve(__dirname, '../../server/data/ai_metrics.jsonl')
const sinceArg = (process.argv.find((item) => item.indexOf('--since=') === 0) || '').slice('--since='.length)
const sinceHours = Number(sinceArg) || 0

if (!fs.existsSync(FILE)) {
  console.log('还没有 ai_metrics.jsonl（跑一次 AI 调用才会生成）')
  process.exit(0)
}

const cutoff = sinceHours ? Date.now() - sinceHours * 3600 * 1000 : 0
const rows = fs.readFileSync(FILE, 'utf8').trim().split('\n')
  .map((line) => {
    try { return JSON.parse(line) } catch (err) { return null }
  })
  .filter((row) => row && row.ts && Date.parse(row.ts) >= cutoff)

const byLabel = new Map()
for (const row of rows) {
  const label = row.label || '(未知)'
  const entry = byLabel.get(label) || { hashes: new Map(), calls: 0, last: '' }
  entry.calls++
  const hash = row.promptHash || '(没有指纹——这行是加指纹之前的老记录)'
  entry.hashes.set(hash, (entry.hashes.get(hash) || 0) + 1)
  if (!entry.last || row.ts > entry.last) entry.last = row.ts
  byLabel.set(label, entry)
}

console.log('label'.padEnd(20) + '调用次数   提示词指纹（次数）')
for (const [label, entry] of [...byLabel.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const hashes = [...entry.hashes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([hash, count]) => hash + '(' + count + ')')
    .join(' ')
  console.log(label.padEnd(20) + String(entry.calls).padEnd(10) + hashes)
}

console.log('')
console.log('提示：一个 label 出现两个以上指纹 = 这段时间里改过提示词；')
console.log('      想知道某个指纹对应哪次改动，看 AI提示词条款.md 里那一块的日期。')
