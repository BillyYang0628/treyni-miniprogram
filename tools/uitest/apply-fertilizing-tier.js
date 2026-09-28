/**
 * 把「施肥优先级」的档位落到购买指南的肥料条目上。
 *
 * 为什么要有这一步：购买库原来每条肥料只有 tips，没有「该不该先买」这层；
 * 用户 2026-09-21 的口径是——花多多这类小包装水溶肥能覆盖绝大多数场景，
 * 羊粪/骨粉这类大包装有机肥属于「想改土再考虑」。
 *
 * 档位定义在 server/data/knowledge/fertilizing_priority.json（唯一来源），
 * 这里只做名字 → 档位的映射；新加肥料条目时要来补一行。
 *
 * 幂等。用法：node apply-fertilizing-tier.js [--dry]
 */
const fs = require('node:fs')
const path = require('node:path')

const GUIDE = path.resolve(__dirname, '../../server/data/knowledge/purchase_guide.json')
const DRY = process.argv.indexOf('--dry') >= 0

// 名字 → 档位。和 fertilizing_priority.json 的 tiers 一一对应
const TIER = {
  // 第 1 档：先买这一包
  '花多多 1 号': 1,
  '美乐棵通用型': 1,
  // 第 2 档：按需再补
  '花多多 2 号': 2,
  '花多多 10 号': 2,
  '花宝 2 号 / 3 号': 2,
  '通用水培营养液（A/B 液）': 2,
  '磷酸二氢钾': 2,
  '奥绿 A2': 2,
  '奥绿 318S': 2,
  '好康多（Hi-Control）': 2,
  '观叶 / 月季 / 多肉 / 兰花等专用肥': 2,
  // 第 3 档：对症或改土才买
  '尿素': 3,
  '螯合铁（EDDHA-Fe）': 3,
  '硫酸亚铁': 3,
  '硫酸镁': 3,
  '硝酸钙 / 氯化钙': 3,
  '骨粉': 3,
  '蚯蚓粪': 3,
  '枯草芽孢杆菌 / 哈茨木霉菌 / EM 菌': 3,
  '腐熟羊粪 / 鸡粪颗粒': 3,
  '海藻酸 / 氨基酸水溶肥': 3,
  '矾肥水（自制/成品）': 3,
  // 第 4 档：特定场景
  '生根粉（ABT / 吲哚丁酸·萘乙酸）': 4,
  '芸苔素内酯': 4,
  '复硝酚钠': 4
}

// 第 3 档里这几条要明说"不是必须买"，否则新手会以为养花就得备一大包
const OPTIONAL_NOTE = {
  '腐熟羊粪 / 鸡粪颗粒': '不是新手必需：养分效果和花多多这类水溶肥重叠，它的价值在改良土壤；要买就买 5-10 斤颗粒小包装',
  '蚯蚓粪': '不是新手必需：温和、能改良土壤，但养分上被均衡水溶肥覆盖；想改土再买',
  '骨粉': '不是新手必需：补磷钙、见效慢，做基肥用；想催花优先用高磷钾水溶肥',
  '枯草芽孢杆菌 / 哈茨木霉菌 / EM 菌': '不是新手必需：土壤板结、连作障碍时再考虑',
  '尿素': '不是新手必需：单一氮肥容易过量烧根，优先用均衡水溶肥',
  '矾肥水（自制/成品）': '不是新手必需：喜酸植物调酸用，自制要发酵、有味道'
}

function main() {
  const text = fs.readFileSync(GUIDE, 'utf8')
  const labels = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../server/data/knowledge/fertilizing_priority.json'), 'utf8')
  ).tier_labels

  let touched = 0
  const unmapped = []

  const lines = text.split('\n').map((line) => {
    const matched = line.match(/^(\s*)(\{"name":"([^"]+)".*\})(,?)$/)
    if (!matched) return line
    const name = matched[3]
    const tier = TIER[name]
    if (tier === undefined) {
      // 不是肥料条目（药剂/器械）就跳过；肥料里没映射的要报出来
      if (line.indexOf('肥料') >= 0 || /花多多|奥绿|磷酸|尿素|羊粪|蚯蚓|骨粉|菌|矾肥/.test(name)) {
        unmapped.push(name)
      }
      return line
    }

    const item = JSON.parse(matched[2])
    item.tier = tier
    item.tier_label = labels[String(tier)]
    const note = OPTIONAL_NOTE[name]
    if (note && (item.tips || []).indexOf(note) < 0) {
      item.tips = [...(item.tips || []), note]
    }
    touched++
    return matched[1] + JSON.stringify(item) + matched[4]
  })

  const output = lines.join('\n')
  JSON.parse(output)

  if (unmapped.length) {
    console.log('注意：这些肥料条目还没映射档位 → ' + unmapped.join('、'))
  }
  if (DRY) {
    console.log('--dry：会改 ' + touched + ' 条')
    return
  }
  fs.writeFileSync(GUIDE, output, 'utf8')
  console.log('标了 ' + touched + ' 条肥料的档位；JSON 校验通过')
}

try {
  main()
} catch (err) {
  console.error('FAILED: ' + ((err && err.stack) || err))
  process.exit(1)
}
