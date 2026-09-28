/**
 * 按淘宝实测（82 个词的首屏）批量改进购买建议。
 *
 * 这张表里的每一条都有实测依据，来源是 tools/gen/purchase-taobao-all.json：
 *   · 首屏混进别的品类 → 改 search / 加 avoid
 *   · 首屏大包装霸屏 → 加「规格认准」
 *   · 首屏有更好的家庭买法 → 写进 tips
 *
 * 幂等：重复跑只是把同样的字段再写一次。
 * 用法：node improve-purchase-guide.js [--dry]
 */
const fs = require('node:fs')
const path = require('node:path')

const GUIDE = path.resolve(__dirname, '../../server/data/knowledge/purchase_guide.json')
const DRY = process.argv.indexOf('--dry') >= 0

/** 器械：实测出来的规格与避坑 */
const TOOLS = {
  '修枝剪': {
    tips: ['十几元的家用园艺剪刀就够用；认准不锈钢刃口、开合顺畅',
      '避开写着「嫁接专用」「电动」的款式，新手用不上',
      '每次用完擦干；剪过病枝前后都要消毒'],
    where: ['淘宝/天猫（重点看刃口材质）', '园艺店']
  },
  '小锯子 / 手锯': {
    search: '盆景锯 修枝锯',
    tips: ['直接搜「手锯」出来的多是木工锯，认准「盆景锯 / 修枝锯」',
      '只在剪直径 1 厘米以上的枝时用得到，家庭先别急着买'],
    avoid: ['别买木工锯 / 钢锯：齿型和锯口不适合剪活枝'],
    where: ['淘宝/天猫', '园艺店']
  },
  '喷壶': {
    tips: ['选 1-2 升气压式、带刻度、喷头能调雾状和柱状',
      '打药和浇花各留一个壶，不要混用',
      '搜「喷壶 打农药专用」能出一批带刻度的'],
    where: ['淘宝/天猫（搜「打农药专用」）', '园艺店']
  },
  '园艺手套': {
    tips: ['选带涂层或胶点的防刺防水款，几元到二十几元都够用',
      '修剪、换盆、打药都建议戴；戴着手套的手别揉眼睛'],
    where: ['淘宝/天猫', '园艺店']
  },
  '口罩': {
    tips: ['配药和喷药都要戴；优先选带熔喷层的防尘款或 KN95',
      '普通一次性医用口罩只能挡飞溅，挡不住药雾颗粒'],
    where: ['淘宝/天猫', '药店']
  },
  '量勺 / 量杯': {
    tips: ['搜出来的厨房烘焙克数勺就够用，买 1g / 2g / 5g 套装',
      '配药按克数来最稳；1 毫升刻度针筒也很好用'],
    where: ['淘宝/天猫（厨房烘焙区就有）', '厨房用品店']
  },
  '植物补光灯': {
    tips: ['阳台单盆选 20-30W 全光谱就够，装在植株上方 30-40 厘米',
      '充电款功率普遍偏小，只适合育苗或补一点光',
      '看功率和照射面积，不是越亮越好'],
    where: ['淘宝/天猫（重点看功率与光谱）']
  },
  'pH 试纸 / EC 笔': {
    tips: ['土培新手可以先不买；喜酸植物和水培才用得上',
      '通用试纸直接插土里测不准：要按说明泡成浸提液，或直接买土壤 pH 计'],
    where: ['淘宝/天猫']
  },
  '标签牌 / 记号笔': {
    tips: ['搜「T 型插牌 / 插地牌」，几元一百个，还防水',
      '记下换盆、用药、施肥的日期，比凭记忆靠谱'],
    where: ['淘宝/天猫', '园艺店']
  },
  '换盆工具（小铲、垫网）': {
    tips: ['1-5 元的园艺小铲三件套就够用，别买几十元的多肉造景套装',
      '垫网防止土从底孔漏出，小铲用来拌土'],
    where: ['淘宝/天猫', '园艺店']
  }
}

/** 肥料：主要是「规格认准」——实测首屏大包装霸屏的那几条 */
const FERTILIZERS = {
  '尿素': {
    tips: ['首屏多是 100 斤大包：家庭搜「尿素 花肥 小包装」，认 500g-2kg',
      '速效氮肥，一次用一点点就够，别和复合肥叠加']
  },
  '硝酸钙 / 氯化钙': {
    tips: ['农资常见 25-40kg 装：家庭认 500g-1kg 的小包装水溶肥',
      '补钙防脐腐、防裂果，用量小，买小包能用很久']
  },
  '骨粉': {
    tips: ['常见 10 斤 / 25kg 装：家庭买 1-2 斤袋装就够用很久',
      '做基肥埋土里，见效慢，别指望它救急']
  },
  '腐熟羊粪 / 鸡粪颗粒': {
    tips: ['首屏多是 100 斤大包：家庭认 5-10 斤的颗粒装，别买散装粉末',
      '一定要看清「腐熟」二字：没腐熟的生粪会烧根、招虫']
  },
  '复硝酚钠': {
    tips: ['常见 2kg / 10kg 装：家庭认 100-200g 小包装',
      '不推荐新手买：它是生长调节剂，浓度错了会起反效果',
      '商品页常写「1.8% 复硝酚钠」，浓度不同用法差别大，按说明来']
  },
  '枯草芽孢杆菌 / 哈茨木霉菌 / EM 菌': {
    tips: ['常见 1kg / 25kg 装：家庭认 100g-1kg 粉剂或 1000ml 活菌液',
      '是活菌，不能和杀菌剂同时用；兑水后尽快用完']
  },
  '花多多 1 号': {
    tips: ['首屏常有 1/2/12 号组合装：只养一盆就别买组合，单独买 100-250g',
      '1 号是均衡型，长叶长枝用；现蕾再换 2 号']
  },
  '花多多 2 号': {
    tips: ['只养一盆不用买多号组合装，单独买 100-250g',
      '促花型，现蕾期用；花期停用避免掉蕾']
  },
  '花多多 10 号': {
    tips: ['只养一盆不用买多号组合装，单独买 100-250g',
      '强促叶型，观花植物慎用（容易徒长不开花）']
  }
}

/** 药剂：补实测看到的「家庭友好买法」（购买要求另由毒性生成，见 purchase_requirements） */
const DRUGS = {
  'D25': { tips: ['低毒，靠覆盖虫体起作用；室内、有宠物家庭相对友好', '家庭阳台可以选「免稀释直喷」装，不用自己兑水'] },
  'D26': { tips: ['蚜虫、蓟马方向', '花盆里撒的「小白药」颗粒剂对阳台最省事（成分就是吡虫啉）'] },
  'D33': { tips: ['搜「Bt 杀虫剂」也能找到；对鳞翅目幼虫有效', '买悬浮剂型，看出厂日期：活菌制剂越新越好'] }
}

/** 按毒性生成「购买要求」：用户要求「有毒的药品一定要加以说明」 */
function requirementsFor(toxicity) {
  const tox = String(toxicity || '')
  const list = [
    '认准农药登记证号（PD 开头）、生产日期与稀释说明；没有标签或手写标签的散装药不买',
    '家庭买最小包装：一次用不完的药液不能留到下次',
    '放在孩子和宠物拿不到的位置，最好单独上锁'
  ]
  if (/中等毒|高毒/.test(tox)) {
    list.push('商品页毒性标识是「中等毒」：请家长下单、家长保管，不要让孩子自己去取快递')
    list.push('连同一次性手套和口罩一起买，配药喷药都要用')
    list.push('不要分装到饮料瓶、矿泉水瓶里，原包装加原标签就是它的身份')
  } else {
    list.push('毒性标识是「低毒」，但仍然是农药：孩子不要单独操作，用完洗手')
  }
  if (/对蜂高毒/.test(tox)) list.push('对蜜蜂高毒：花期或附近有蜂群时不要用（下单前就要知道）')
  if (/对鱼高毒/.test(tox)) list.push('对鱼高毒：家里有鱼缸或水景时不要买')
  if (/强碱腐蚀/.test(tox)) list.push('强碱腐蚀：别和皮肤、金属直接接触，直立存放')
  return list
}

function main() {
  const text = fs.readFileSync(GUIDE, 'utf8')
  const drugs = JSON.parse(fs.readFileSync(path.join(path.dirname(GUIDE), 'pesticide_drugs.json'), 'utf8')).drugs
  let touched = 0

  const lines = text.split('\n').map((line) => {
    // 药剂：key 是 D01 / X03，一行一条
    const drugMatch = line.match(/^(\s*"([A-Z]\d{2})":\s*)(\{.*\})(,?)$/)
    if (drugMatch) {
      const code = drugMatch[2]
      const item = JSON.parse(drugMatch[3])
      item.where = ['淘宝/天猫 农药专营店（优先，认准登记证号）', '线下农资店（就近，可以请店主帮忙挑）']
      item.purchase_requirements = requirementsFor((drugs[code] || {}).toxicity)
      const patch = DRUGS[code]
      if (patch && patch.tips) item.tips = patch.tips
      touched++
      return drugMatch[1] + JSON.stringify(item) + drugMatch[4]
    }

    // 肥料 / 器械：{"name":"...", ...}
    const namedMatch = line.match(/^(\s*)(\{"name":"([^"]+)".*\})(,?)$/)
    if (namedMatch) {
      const name = namedMatch[3]
      const patch = TOOLS[name] || FERTILIZERS[name]
      if (!patch) return line
      const item = JSON.parse(namedMatch[2])
      if (patch.search) item.search = patch.search
      if (patch.where) item.where = patch.where
      else if (TOOLS[name]) item.where = TOOLS[name].where
      else item.where = ['淘宝/天猫（认准官方旗舰店或农资专营店）', '园艺店 / 农资店（就近）']
      if (patch.tips) item.tips = patch.tips
      if (patch.avoid) item.avoid = patch.avoid
      touched++
      return namedMatch[1] + JSON.stringify(item) + namedMatch[4]
    }

    return line
  })

  const output = lines.join('\n')
  JSON.parse(output)

  if (DRY) {
    console.log('--dry：改了 ' + touched + ' 条，没有写盘')
    return
  }
  fs.writeFileSync(GUIDE, output, 'utf8')
  console.log('改进 ' + touched + ' 条；JSON 校验通过')
}

try {
  main()
} catch (err) {
  console.error('FAILED: ' + ((err && err.stack) || err))
  process.exit(1)
}
