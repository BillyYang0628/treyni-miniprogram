const knowledge = require('./knowledge')
const config = require('../config')
const aiMetrics = require('./aiMetrics')
const aiBudget = require('./aiBudget')
const { restInfo } = require('./transplantRest')

const AI_TIMEOUT_MS = 300000

/**
 * 各板块的思考强度。
 * 口径（2026-09-14 确认）：质量优先，单次生成控制在一分钟内即可，所以不再使用 disabled，
 * 一律至少 low；涉及用药安全与判断的用 high。
 *   high —— 用药指导、换药建议、视觉复核、病害介绍、花农对话、养护报告（2026-09-14 按用户要求上调）
 *   low  —— 受知识库强约束的写作与轻决策（提醒方案、下一轮提醒、会话压缩）
 * 全局可用 AI_THINKING_OVERRIDE 覆盖，便于对比调试。
 * 说明：DeepSeek 支持三档 + 关闭；Moonshot（K2.6）只支持开/关，low/high/max 会被降级成"开"。
 */
const THINKING_POLICY = {
  'diagnosis.treatment': 'high',
  // 2026-09-20（A-4）：这块原来是 high，实测思考预算会被整段吃光、
  // 正文一个字都吐不出来，只能靠"退回非思考重试"兜底。ai_metrics 的实测：
  // 思考档 31-48 秒、输出 0 字（finish=length），紧接着非思考重试 3 秒、输出 500+ 字。
  // 也就是说思考档只贡献了等待，最终的文本本来就是非思考产出的，所以直接关掉。
  'treatment.consult': 'disabled',
  'diagnosis.vision': 'high',
  'diagnosis.summary': 'high',
  'reminder.detail': 'low',
  nextReminder: 'low',
  'chat.gardener': 'high',
  'chat.summarize': 'low',
  careReport: 'high',
  // 完成回执只是"把勾选项说成一句人话"，不需要推理；
  // 关掉思考才能压进 1.5 秒的动画窗口（前端不等它，但想让它赶上）。
  'complete.echo': 'disabled'
}

/**
 * 各板块的正文输出上限。DeepSeek 官方明确提醒：JSON 模式必须设 max_tokens，
 * 否则长回答会被截断成半截 JSON（实测对话回复被截断后把 {"reply":"..." 原文抛给了用户）。
 */
const MAX_TOKENS_POLICY = {
  'diagnosis.treatment': 1600,
  'treatment.consult': 1600,
  'diagnosis.summary': 1200,
  'diagnosis.vision': 600,
  'reminder.detail': 2200,
  nextReminder: 1200,
  'chat.gardener': 2200,
  'chat.summarize': 800,
  careReport: 3000,
  // 一句话（≤25 字）不需要大额度；不设的话请求里不会带 max_tokens
  'complete.echo': 120
}

/**
 * 思考模式下的额外预算：思考 token 也计入 max_tokens，
 * 只给正文留额度会让模型"想完了没额度说话"，直接返回空内容（实测 treatment/consult 出现过）。
 */
const THINKING_BUDGET = {
  disabled: 0,
  low: 6000,
  high: 9000,
  max: 12000
}

/**
 * 统一的写作规范，来源：《对话式文本生成提示词》与知识库写作口径。
 * 所有面向用户的 AI 文本（用药指导、病害介绍、养护方案、调整方案）都必须遵守。
 */
const WRITING_STYLE_RULES = [
  '写法要求（必须严格照做）：',
  '1. 生活化口语：像有经验的花友面对面分享，多用“种好后”“就更好了”“没什么关系”这类说法，不要学术腔。',
  '2. 强提醒式：关键点用“切记”“要注意”“别踩坑”引出，把常见误区直白点破，并说清这样做的原因。',
  '3. 量化实操：光照给小时数、温度给 ℃、浇水给厘米和天数、施肥给克数与兑水量；',
  '   禁止出现“适量”“大概”“少量”这类模糊说法。',
  '4. 新手友好：复杂或高风险的操作要标注“不推荐新手尝试”；遇到异常先讲原因，再给能一步步照做的办法。',
  '5. 分点呈现：用 ①②③ 或 1) 2) 3) 编号，方便用户逐条阅读。',
  '6. 科学信息必须保留：专业名词和浓度倍数照常出现（例如“苯醚甲环唑”“3000倍稀释液”），',
  '   但每出现一个就要紧跟一句大白话解释，例如“3000倍液，就是1克药兑3升水，大约一小勺药兑三大瓶矿泉水”。',
  '7. 用自然的过渡语衔接解释，例如“简单来说”“也就是”“你可以这样理解”，不要先给结论再硬加一句注释。',
  '8. 只输出正文，不要标题、不要 markdown 符号、不要空话和鼓励语（但段落之间的空行是必须的）。',
  '',
  // 2026-09-20 加：模型以前把"分点呈现"理解成"在同一段里编号"，
  // 结果 400 多字挤成一坨，界面上根本没法读（批注 2）。
  '9. 必须分段：每个 ①②③ / 1) 2) 3) 条目**独占一段**，条目与条目之间空一行；',
  '   禁止把 3 个以上要点写在同一段里——这是最常返工的一处。',
  '10. 每段最多 3 句话；开头那句结论单独成一段，与正文之间空一行。',
  '11. 不分点的文本（例如病害介绍）也不能连成一段，按「是什么 / 长什么样 / 什么条件下发生 / 怎么预防」各自独立成段。'
]

/**
 * 用药相关的共享条款（2026-09-20，来源：批注 1「配药警告」）。
 *
 * 为什么单独拉一份：6 处提示词里都可能出现药剂，
 * 「配药由家长参与」这条红线必须**一处改、处处生效**，
 * 不能在 6 个提示词里各写一遍（改一处漏五处是必然的）。
 *
 * 条款自带触发条件（"只要正文里出现药剂"），所以非打药场景拼进去也不会误伤。
 *
 * 购买指路（"搜什么词、去哪儿买"）依赖「购买指南」库，2026-09-20 已接入：
 * knowledge.describePurchaseGuide() 按当前内容里出现的物品取最多 3 条资料拼进提示词，
 * 有资料才允许写购买建议，没资料一个字都不许提（编出来的品牌会被当成事实照做）。
 */
const PESTICIDE_SAFETY_RULES = [
  '用药安全（和上面的写法要求同等重要，条件成立就必须写）：',
  '12. 只要正文里出现药剂，安全注意事项那一条必须写清配药由谁来做，照这句写：',
  '    「配药这一步请和家长一起做，或者请家长按说明兑好，你负责喷。」',
  '    不要写成「小朋友不能碰农药」这类说辞，也不要写成「严禁独自配药」这种命令句。',
  '13. 购买指路：**先看这段提示词里有没有「购买指路资料」这一块**——',
  '    · 有这一块：里面列出的物品就要在正文最后补一句自然的话，用资料里的搜索词和渠道（网上买以',
  '      淘宝/天猫的农药专营店、官方旗舰店为主），例如「可以搜『苯醚甲环唑 杀菌剂』，认准包装上的',
  '      农药登记证号，家庭用买小包装」。别因为字数紧就省掉，它是用户真的会照做的一步。',
  '    · 资料里标了「必须写进正文的购买要求」的物品（中毒风险高的农药），要按下面这句写进正文，',
  '      把「这个药」换成物品名：「这个药是中等毒，请家长下单并帮忙保管，认准包装上 PD 开头的农药登记证号，',
  '      买最小包装，不要分装到饮料瓶里。」这几条属于安全内容，**和上面的字数上限冲突时以它为准**，',
  '      可以少说别的，但这句不能省、也不要改成别的说法。',
  '    · 资料里的「购买要求」栏也一样：低毒的药提一句「认准登记证号、放孩子拿不到的地方」就够。',
  '    · 只给**正文里真的用到的**物品写购买建议：资料里列了但这次方案没用到的，一个字都不要提。',
  '    · **肥料看「优先级」那一栏**：标了「第 1 档·先买这一包就够」的，要点明「先买这一包就能用，',
  '      别的按需再补」；标了「第 3 档·对症或改土才买」的（有机肥、单一元素肥），要说清「不是必需」，',
  '      别让新手以为养花必须先搬一大包羊粪回来。',
  '    · 没有这一块：**一个字都不要提购买**，也不要凭常识替用户想搜索词、渠道或商品名。',
  '    资料里没列到的物品同样不要提（品牌名、店铺名、价格、链接、销量评价都算），自己编出来的会被当成事实照做。'
]

/**
 * 把 JSON **字符串字面量内部**的裸换行/制表符转成转义形式。
 *
 * 为什么需要（2026-09-21 块 3 实测抓到）：模型会把真换行直接写进 JSON 字符串里，
 * `{"detail":"第一行<真换行>第二行"}` 在 JSON 里是非法的 → 整个串解不出来，
 * 表现就是「方案页显示一坨 {"detail":"…」「候选全空」。
 * 这里逐字符扫，只处理字符串内部，结构部分不动。
 */
function repairJsonControlChars(text) {
  let out = ''
  let inString = false
  let escaped = false

  for (const ch of String(text || '')) {
    if (!inString) {
      if (ch === '"') inString = true
      out += ch
      continue
    }
    if (escaped) {
      out += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      out += ch
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = false
      out += ch
      continue
    }
    if (ch === '\n') { out += '\\n'; continue }
    if (ch === '\r') { out += '\\r'; continue }
    if (ch === '\t') { out += '\\t'; continue }
    out += ch
  }

  return out
}

/** JSON 字符串里的 \n \t \" 还原成真字符 */
function unescapeJsonString(value) {
  return String(value || '')
    .replace(/\\r\\n|\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
}

class AIAdapter {
  async diagnosePlant(imageUrl, context = {}) {
    this.assertBaiduConfigured()

    const accessToken = await this.getBaiduAccessToken()
    const imageValue = imageUrl.startsWith('http')
      ? imageUrl
      : imageUrl.replace(/^data:image\/\w+;base64,/, '')
    const params = new URLSearchParams()
    params.set('image', imageValue)
    params.set('baike_num', '3')
    params.set('access_token', accessToken)

    const response = await fetch(config.baidu.plantApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString(),
      signal: AbortSignal.timeout(20000)
    })

    const data = await response.json()

    if (!response.ok || data.error_code || data.error_msg) {
      const err = new Error(data.error_msg || '百度植物识别调用失败')
      err.code = data.error_code ? `BAIDU_${data.error_code}` : 'BAIDU_HTTP_ERROR'
      err.status = 502
      throw err
    }

    const top = Array.isArray(data.result) && data.result.length ? data.result[0] : null

    if (!top) {
      const err = new Error('百度植物识别未返回有效结果')
      err.code = 'BAIDU_EMPTY_RESULT'
      err.status = 502
      throw err
    }

    const label = top.name || ''
    const confidence = typeof top.score === 'number' ? top.score : null
    const diseaseLabel = this.inferDisease(label)

    return {
      // 百度返回的是“植物识别”标签，只作参考，不作为本植物的品种依据
      label,
      label_confidence: confidence,
      plant_reference: diseaseLabel ? '' : label,
      // 只有命中病虫害关键词时，才把该标签当作病虫害线索
      disease: diseaseLabel,
      disease_confidence: diseaseLabel ? confidence : null,
      baike: top.baike_info || null,
      raw: data
    }
  }

  /**
   * 生成两段面向不同用途的内容（并行调用，避免串行等待过久）：
   * - treatment：写给“每日提醒”，侧重打药方案和注意事项
   * - summary：写给“植物养护历程”，侧重病害介绍，不写具体打药流程
   */
  async generateDiagnosisReport(plantInfo, diagnosis) {
    this.assertAIConfigured()

    const species = plantInfo && (plantInfo.species || plantInfo.variety || plantInfo.name)
    const disease = diagnosis && diagnosis.disease
    const severity = diagnosis && diagnosis.severity
    const evidence = diagnosis && diagnosis.evidence
    const referenceLabel = diagnosis && diagnosis.identification
      ? diagnosis.identification.label
      : ''

    const severityText = {
      mild: '轻微',
      moderate: '中等',
      severe: '严重',
      unknown: '不确定'
    }[severity] || '不确定'

    const profileLines = [
      `植物品种（以用户档案为准，不得更改）：${species || '未填写'}`,
      `植物名称：${(plantInfo && plantInfo.name) || '未填写'}`,
      `花盆：${(plantInfo && plantInfo.pot_size) || '未填写'}`,
      `土壤：${(plantInfo && plantInfo.soil_type) || '未填写'}`,
      `摆放位置：${(plantInfo && plantInfo.location) || '未填写'}`,
      `光照环境：${(plantInfo && plantInfo.light_environment) || '未填写'}`
    ]

    const problemLines = [
      `判断出的病虫害：${disease || '未识别出明确病虫害'}`,
      `严重程度：${severityText}`,
      evidence ? `判断依据：${evidence}` : '',
      referenceLabel ? `图片识别参考（仅供参考，不代表本植物品种）：${referenceLabel}` : ''
    ].filter(Boolean)

    const contextLines = [
      ...profileLines,
      '',
      ...problemLines,
      ''
    ]

    // 用药库参考：药剂、浓度、间隔一律以病虫害用药库为准
    const diseaseInfo = knowledge.findDisease(disease)
    const speciesTargets = knowledge.getSpeciesPesticideTargets(plantInfo && plantInfo.species)
    const pesticideLines = []

    if (diseaseInfo) {
      pesticideLines.push(`病虫害档案（来自「病虫害用药库」${diseaseInfo.code} ${diseaseInfo.entry.name}）：`)
      if (diseaseInfo.entry.symptom) pesticideLines.push('识别特征：' + diseaseInfo.entry.symptom)
      pesticideLines.push('预防期：' + knowledge.describeScheme(diseaseInfo, 'prevention'))
      pesticideLines.push('轻度：' + knowledge.describeScheme(diseaseInfo, 'mild'))
      pesticideLines.push('中重度：' + knowledge.describeScheme(diseaseInfo, 'severe'))
      if (diseaseInfo.entry.note) pesticideLines.push('该病害注意：' + diseaseInfo.entry.note)
    }

    if (speciesTargets && speciesTargets.targets.length) {
      pesticideLines.push(
        `这个品种的常见病虫害：${speciesTargets.commonPests.join('、')}`
      )
      if (speciesTargets.advice) pesticideLines.push('品种用药提醒：' + speciesTargets.advice)
    }

    if (pesticideLines.length) {
      pesticideLines.push('')
      pesticideLines.push('安全红线（必须遵守）：')
      for (const group of knowledge.getPesticideSafety()) {
        if (group.title.includes('一律禁用')) continue
        pesticideLines.push(group.title + '：' + group.items.join(' ').slice(0, 400))
      }
    }

    // 购买指路：只有当前这份方案里真的会出现的东西才配资料（没有就是空数组）
    const treatmentGuideLines = knowledge.describePurchaseGuide(
      [...contextLines, ...pesticideLines].join('\n')
    )

    const treatmentMessages = [
      {
        role: 'system',
        content: [
          '你是一名家庭园艺植物医生，服务对象是中小学生和他们家里的盆栽。',
          '植物品种一律以用户提供的植物档案为准，不要因为图片识别结果或参考标签而改变植物品种。',
          '若参考标签与该品种明显不符，直接忽略该参考标签，不要据此更换药剂或防治对象。',
          '你现在只写“用药指导”这一段，它会出现在每日提醒里，是写给负责打药的人看的。',
          '药剂名称、稀释倍数、喷施间隔必须从下面提供的「病虫害用药库」里选，不要自己发明药剂或浓度。',
          '第一次用药按「方案 A」；如果这是复喷，或用户反馈上一轮用药无效，改用「方案 B」，',
          '因为方案 B 是不同作用机理的药；任何情况下都不要用加大剂量的办法硬扛。',
          '按 1) 药剂名称与稀释倍数；2) 喷施方法与重点部位；3) 喷施间隔与建议次数；',
          '4) 安全注意事项；5) 建议复查时间 的顺序，写成 5 条。',
          // 400 → 440：末尾的购买指路那句也要占额度，实测卡在 400 时模型会把它省掉
          '每条 1-2 句话，全文不超过 440 字（末尾要写购买指路时，那句也算在里面），不要写病害原理和科普。',
          '',
          ...WRITING_STYLE_RULES,
          ...PESTICIDE_SAFETY_RULES
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          ...contextLines,
          ...pesticideLines,
          '',
          ...(treatmentGuideLines.length ? [...treatmentGuideLines, ''] : []),
          '请只输出用药指导这一段，药剂和浓度必须来自上面的用药库。'
        ].join('\n')
      }
    ]

    const summaryMessages = [
      {
        role: 'system',
        content: [
          '你是一名家庭园艺植物医生，服务对象是中小学生和他们家里的盆栽。',
          '植物品种一律以用户提供的植物档案为准，不要因为图片识别结果或参考标签而改变植物品种。',
          '你现在只写“病害介绍”这一段，它会出现在植物养护历程里。',
          '写清楚这是什么病、在叶片上长什么样、什么条件下容易发生、以后怎么预防，',
          '需要时可以结合档案里的摆放位置和光照条件。',
          '不要写具体药剂名称、稀释倍数和喷药步骤，全文不超过 350 字。',
          '',
          ...WRITING_STYLE_RULES,
          ...PESTICIDE_SAFETY_RULES
        ].join('\n')
      },
      {
        role: 'user',
        content: [...contextLines, '请只输出病害介绍这一段。'].join('\n')
      }
    ]

    const [treatment, summary] = await Promise.all([
      this.callChatModel(treatmentMessages, AI_TIMEOUT_MS, 'AI 用药指导生成失败', { label: 'diagnosis.treatment' }),
      this.callChatModel(summaryMessages, AI_TIMEOUT_MS, 'AI 病害介绍生成失败', { label: 'diagnosis.summary' })
    ])

    const treatmentText = String(treatment || '').trim()
    const summaryText = String(summary || '').trim()

    if (!treatmentText || !summaryText) {
      const err = new Error('Moonshot 返回的诊断报告不完整，缺少用药指导或病害介绍')
      err.code = 'AI_INCOMPLETE_REPORT'
      err.status = 502
      throw err
    }

    return { treatment: treatmentText, summary: summaryText }
  }

  /**
   * 两个疗程都没有效果后，请 AI 判断是否需要换药、调整方案。
   * 只返回建议文本，落库由用户确认后再执行。
   */
  /**
   * 完成一条提醒后，由 AI 结合植物档案、知识库和历史日记，
   * 决定下一轮提醒的间隔、摘要和详细内容。
   * 只输出 JSON，失败会抛错，由调用方显式暴露。
   */
  async generateNextReminderAdvice(plantInfo, context = {}) {
    this.assertAIConfigured()

    const species = plantInfo && (plantInfo.species || plantInfo.variety || plantInfo.name)
    const typeLabel = {
      watering: '浇水',
      fertilizing: '施肥',
      pesticide: '打药',
      pruning: '修剪'
    }[context.type] || '养护'

    const profileLines = [
      `植物品种（以用户档案为准，不得更改）：${species || '未填写'}`,
      `植物名称：${(plantInfo && plantInfo.name) || '未填写'}`,
      `花盆：${(plantInfo && plantInfo.pot_size) || '未填写'}`,
      `土壤：${(plantInfo && plantInfo.soil_type) || '未填写'}`,
      `摆放位置：${(plantInfo && plantInfo.location) || '未填写'}`,
      `光照环境：${(plantInfo && plantInfo.light_environment) || '未填写'}`,
      `种植日期：${(plantInfo && plantInfo.planting_date) || '未填写'}`,
      `今天日期：${new Date().toISOString().slice(0, 10)}`
    ]

    const knowledgeLine = context.knowledge
      ? `知识库标准做法（来自「${context.knowledge.libraryLabel}」，请以此为基准，结合实际情况微调）：` +
        `标准间隔 ${context.knowledge.interval_days} 天；${context.knowledge.note || ''}`
      : ''

    const historyLines = (context.history || []).map((item) => '- ' + item)

    // 浇水：日期与间隔已经由天气系数模型算好（含降雨重置），AI 不能改，
    // 只负责把"为什么这么安排"和"接下来怎么做"写成用户看得懂的话
    const water = context.water || null
    const waterLines = water
      ? [
          `天气模型已经算好了：下一次浇水 ${water.next_due_date || '—'}，按每 ${water.interval_days || '—'} 天一次安排`,
          water.et0 ? `当地当前蒸发量约 ${water.et0} mm/天` : '',
          water.city ? `天气来源：${water.city}` : '',
          water.tank_percent !== undefined && water.tank_percent !== null
            ? `土壤水分账户剩余约 ${water.tank_percent}%`
            : '',
          water.rain_reset_days && water.rain_reset_days.length
            ? `${water.rain_reset_days.join('、')} 下过雨，相当于浇了一次水，日期已重置`
            : ''
        ].filter(Boolean)
      : []

    const messages = [
      {
        role: 'system',
        content: [
          '你是一名家庭园艺植物医生，服务对象是中小学生和他们家里的盆栽。',
          '用户刚刚完成了这次“' + typeLabel + '”，现在要安排下一轮提醒。',
          '请结合植物档案、知识库标准做法、最近的养护记录和完成情况，决定下一次的间隔和内容。',
          '要求：',
          '1. 间隔天数要落在合理区间内（1–180 天），可以和知识库标准间隔不同，但必须说明理由；',
          '   例如天气转凉可以拉长、秋季生长旺盛可以缩短。',
          '2. 详细内容要能让用户照着做，写法参考下面的写作规范。',
          '3. 如果档案里缺少必要信息（例如室温、具体朝向），按常见情况给方案，并在 reason 里说明你的假设。',
         '4. 只输出一个 JSON，不要输出其他文字，格式：',
          '{"interval_days":数字,"summary":"一句话摘要，不超过 30 字","detail":"详细操作内容","reason":"为什么这样安排，1-2 句",' +
            '"options":["这次实际做了什么的候选，最多 4 个，要具体"],"ask":"这次完成时就这个品种/方案要问用户的一句实时问题"}',
      '5. JSON 字符串内部不要使用英文双引号，需要引用时用中文引号「」；输出必须能被 JSON.parse 直接解析。',
      '6. 档案里的“开始养护日期”是用户到手/开始养它的日期，不要当成播种日期，也不要用它推算苗龄。',
      '7. options 是给用户完成后勾选「这次实际用了什么」用的：只列这条方案里真的可能出现的选择，' +
        '名字要具体（写「苯醚甲环唑3000倍液」而不是「药」）。' +
        'ask 是这次要问用户的一句话（例如「这次喷了叶背吗？」「浓度是按说明配的吗？」），问的是方案里的关键细节，不要问常识。',
      ...(water
        ? ['7. 这是浇水提醒，下一次的日期和间隔已经由当地天气模型算好（含降雨重置），' +
            'interval_days 必须填模型给出的天数，不要自己改；' +
            '你只负责把摘要、详细步骤和理由写好，理由里要体现天气依据。']
        : []),
          '',
          ...WRITING_STYLE_RULES,
          ...PESTICIDE_SAFETY_RULES
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          ...profileLines,
          '',
          knowledgeLine,
          '',
          ...(waterLines.length ? ['天气模型给出的浇水安排（不要更改）：', ...waterLines, ''] : []),
          '最近的养护记录（新到旧）：',
          ...(historyLines.length ? historyLines : ['- 暂无记录']),
          '',
          `请给出下一轮${typeLabel}提醒的安排。`
        ].join('\n')
      }
    ]

    const content = await this.callChatModel(messages, AI_TIMEOUT_MS, 'AI 下一轮提醒生成失败', {
      label: 'nextReminder',
      json: true
    })
    const parsed = this.parseJsonContent(content)

    // 浇水以天气模型为准：即使模型自己改了天数，也以模型算出的为准
    const intervalDays = water && Number(water.interval_days)
      ? Number(water.interval_days)
      : Number(parsed.interval_days)
    const summary = String(parsed.summary || '').trim()
    const detail = String(parsed.detail || '').trim()

    if (!Number.isFinite(intervalDays) || intervalDays < 1 || intervalDays > 180) {
      const err = new Error('AI 返回的间隔天数不合理：' + String(parsed.interval_days))
      err.code = 'AI_INVALID_INTERVAL'
      err.status = 502
      throw err
    }

    if (!summary || !detail) {
      const err = new Error('AI 返回的下一轮提醒内容不完整')
      err.code = 'AI_INCOMPLETE_NEXT_REMINDER'
      err.status = 502
      throw err
    }

      return {
        interval_days: Math.round(intervalDays),
        summary,
        detail,
        reason: String(parsed.reason || '').trim(),
        // 方案级候选 + 要问用户的实时问题（第 5 期）。
        // 模型可能不返回或返回脏数据，这里统一清洗，绝不让脏值流到前端。
        options: (Array.isArray(parsed.options) ? parsed.options : [])
          .map((item) => String(item || '').trim())
          .filter(Boolean)
          .slice(0, 4),
        ask: String(parsed.ask || '').trim().slice(0, 60)
      }
  }

  async generateTreatmentAdjustment(plantInfo, context = {}) {
    this.assertAIConfigured()

    const species = plantInfo && (plantInfo.species || plantInfo.variety || plantInfo.name)
    const disease = context.disease || '未明确'

    const profileLines = [
      `植物品种（以用户档案为准，不得更改）：${species || '未填写'}`,
      `植物名称：${(plantInfo && plantInfo.name) || '未填写'}`,
      `花盆：${(plantInfo && plantInfo.pot_size) || '未填写'}`,
      `土壤：${(plantInfo && plantInfo.soil_type) || '未填写'}`,
      `摆放位置：${(plantInfo && plantInfo.location) || '未填写'}`,
      `光照环境：${(plantInfo && plantInfo.light_environment) || '未填写'}`,
      `当前日期：${new Date().toISOString().slice(0, 10)}`
    ]

    const historyLines = (context.rounds || []).map((item) => {
      return [
        `第 ${item.round} 轮用药方案：${String(item.plan || '').slice(0, 400)}`,
        item.feedback ? `第 ${item.round} 轮效果反馈：${item.feedback}` : ''
      ].filter(Boolean).join('\n')
    })

    // 两轮无效后的换药判断，同样以病虫害用药库为准
    const diseaseInfo = knowledge.findDisease(disease)
    const speciesTargets = knowledge.getSpeciesPesticideTargets(plantInfo && plantInfo.species)
    const libraryLines = []

    if (diseaseInfo) {
      libraryLines.push(`病虫害档案（来自「病虫害用药库」${diseaseInfo.code} ${diseaseInfo.entry.name}）：`)
      libraryLines.push('预防期：' + knowledge.describeScheme(diseaseInfo, 'prevention'))
      libraryLines.push('轻度：' + knowledge.describeScheme(diseaseInfo, 'mild'))
      libraryLines.push('中重度：' + knowledge.describeScheme(diseaseInfo, 'severe'))
      if (diseaseInfo.entry.note) libraryLines.push('该病害注意：' + diseaseInfo.entry.note)
    }

    if (speciesTargets && speciesTargets.targets.length) {
      libraryLines.push(`这个品种的常见病虫害：${speciesTargets.commonPests.join('、')}`)
      libraryLines.push('品种用药速查：' + speciesTargets.targets
        .map((item) => `${item.name}｜预防 ${item.prevention}｜轻度 ${item.mild}｜中重度 ${item.severe}｜换用 ${item.alternative}`)
        .join('；').slice(0, 800))
    }

    if (libraryLines.length) {
      libraryLines.push('')
      libraryLines.push('安全红线：')
      for (const group of knowledge.getPesticideSafety()) {
        if (group.title.includes('一律禁用')) continue
        libraryLines.push(group.title + '：' + group.items.join(' ').slice(0, 400))
      }
    }

    // 换成什么药是这一段的重点，所以购买指路按"用药库里出现的药"来配
    const consultGuideLines = knowledge.describePurchaseGuide(
      [...profileLines, ...libraryLines].join('\n')
    )

    const messages = [
      {
        role: 'system',
        content: [
          '你是一名家庭园艺植物医生，服务对象是中小学生和他们家里的盆栽。',
          '植物品种一律以用户提供的植物档案为准，不要更改植物品种。',
          '这盆植物已经按同一个方案连续用药两个疗程，但用户反馈都没有明显改善。',
          '换药必须从下面提供的「病虫害用药库」里选，优先换到不同作用机理的药剂，不要加大剂量。',
          '用户现在很着急，这段文本要像有经验的花友当面出主意，不要写成检验报告。',
          '请你判断原因并给出调整后的方案，按下面的结构写，保留编号，小标题用口语：',
          '1) 先看看为什么没打住：列出 2-3 个最可能的原因，例如抗药性、喷药部位没覆盖到、环境太闷湿。',
          '2) 这轮换成什么药：给出新的药剂类型和稀释倍数，说明为什么要换这一类；',
          '   如果建议继续用同类药，也要说明理由和需要改变的地方。',
          '3) 怎么喷才不白喷：喷施时间、重点部位、间隔天数和建议次数。',
          '4) 环境上怎么配合：结合档案里的摆放位置和光照，说明通风、浇水、清理病叶等配合动作。',
          '5) 什么时候该找人帮忙：说明继续观察多久、什么情况下要重新诊断或请专业人员处理。',
          '',
          '这一段还要额外做到（2026-09-20 批注 5）：',
          '- 第一句先给结论——最可能的原因 + 这轮换成什么药，不超过 40 字；空一行再展开 5 点。',
          '  间隔天数、喷几次这类细节放第 3 点，别塞进开头那句（实测塞进去会变成 50 多字的长句）。',
          '- 每点的第一句必须是判断句，第二句起才是做法；一句话里不要堆 3 个以上专业名词。',
          '- 全文 350-520 字，**一共 12 句封顶**：开头结论 1 句，下面每点**只**写 2 句，',
          '  需要写购买指路时再加 1 句（购买那句也算进字数里）。',
          '  每点写完第 2 句就停手，第 3 句起一律删掉——多写的那几句正是"报告体"的来源。',
          '  宁可每点写短一点，也不要为了讲全把总句数顶到 12 句以上。单句不超过 40 字。',
          '- 不要写「综上所述」「因此建议」「针对该情况」这类书面连接词；可以用「咱们」「你这盆」「说白了」。',
          '  每点最多用一次「也就是」。',
          '',
          ...WRITING_STYLE_RULES,
          ...PESTICIDE_SAFETY_RULES
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          ...profileLines,
          '',
          `要处理的病虫害：${disease}`,
          '',
          ...historyLines,
          '',
          ...libraryLines,
          '',
          ...(consultGuideLines.length ? [...consultGuideLines, ''] : []),
          '请给出调整后的方案。'
        ].join('\n')
      }
    ]

    const content = await this.callChatModel(messages, AI_TIMEOUT_MS, 'AI 用药方案调整生成失败', {
      label: 'treatment.consult'
    })
    const text = String(content || '').trim()

    if (!text) {
      const err = new Error('Moonshot 未返回有效的调整方案')
      err.code = 'AI_EMPTY_RESULT'
      err.status = 502
      throw err
    }

    return text
  }

  /**
   * 物种级「常见用品候选」（第 5 期）。
   *
   * 用途：完成面板里"这次实际用了什么"的可勾选项。
   * 之所以放在物种级：同一个品种两盆植物会用的药、肥是一样的，
   * 没必要每盆、每条提醒都让 AI 重想一遍。
   *
   * 提示词只有三块（角色 / 约束 / 输出格式），约束刻意保守：
   * **宁少不编**——这是给中小学生看的勾选项，编出来的候选会被当成事实选走。
   */
  async generateSpeciesCareOptions(species, careGroup) {
    this.assertAIConfigured()

    const messages = [
      {
        role: 'system',
        content: [
          '你是一名家庭园艺植物医生，服务对象是中小学生和他们家里的盆栽。',
          `现在要为「${species}」整理一份常见候选清单，供用户在完成养护后勾选"这次实际用了什么/做了什么"。`,
          '约束：',
          '1. 只列这个品种确实会用到的；不确定就不要写，宁可少列。',
          '2. 每类最多 4 个，名字要具体（写「花多多1号」而不是「肥料」）。',
          '3. 不要写剂量和稀释倍数，那是具体方案的事。',
          '4. 不要写品牌广告词，不要出现「推荐」「最好」这类词。',
          // 2026-09-20 A-3：实跑返回过 {"pruning":["修枝剪","园艺手套","酒精棉片","小锯子"]}，
          // 而面板问的是「这次剪了什么」，两边语义打架，用户不知道在勾动作还是勾工具。
          '5. 这三组里只有 pruning 的语义不同：它列的是「这次剪了什么」，只写修剪动作或部位',
          '   （例如 剪了枯枝病叶、剪掉过密枝、摘心打顶、疏蕾、剪残花、短截徒长枝）；',
          '   不要列工具（修枝剪、小锯、喷壶、园艺手套、酒精棉片、量勺、植物灯都不算）。',
          '   fertilizing 和 pesticide 这两组列的是「用了什么」，保持原样。',
          '只输出一个 JSON，不要输出其他文字，格式：',
          '{"fertilizing":[],"pesticide":[],"pruning":[]}'
        ].join('\n')
      },
      {
        role: 'user',
        content: '品种：' + species + (careGroup ? '\n养护大类：' + careGroup : '')
      }
    ]

    const content = await this.callChatModel(messages, AI_TIMEOUT_MS, '用品候选生成失败', {
      label: 'speciesOptions',
      json: true
    })
    const parsed = this.parseJsonContent(content) || {}

    const pick = (value) => (Array.isArray(value) ? value : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 4)

    return {
      fertilizing: pick(parsed.fertilizing),
      pesticide: pick(parsed.pesticide),
      pruning: pick(parsed.pruning)
    }
  }

  /**
   * 完成回执造句（B-2，2026-09-20）。
   *
   * 用户勾完"这次实际做了什么"，完成面板会把勾选项当成一句「我」说的话发出去。
   * 这个调用只负责把那串选项说成人话，**不做判断、不给建议**——
   * 一个字的多余都会被用户当成托蕾妮在评价他。
   *
   * 低延迟优先：thinking disabled（见 THINKING_POLICY）、max_tokens 120。
   * 前端只等 1.5 秒，等不到就用本地拼接的那句，所以这里失败不是故障。
   */
  async echoCompletion(context = {}) {
    this.assertAIConfigured()

    const typeLabel = {
      watering: '浇水',
      fertilizing: '施肥',
      pesticide: '打药',
      pruning: '修剪'
    }[context.type] || '养护'

    const items = (Array.isArray(context.items) ? context.items : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 8)

    if (!items.length) return ''

    const messages = [
      {
        role: 'system',
        content: [
          '你正在帮用户把一次养护记录说成一句自己的话，像用户在聊天里汇报。',
          '要求：',
          '1. 用第一人称，只写"我做了什么"，例如「我给月季浇透了水」。',
          '2. 不加建议、不加评价、不表扬也不提醒，不要出现"记得""建议""下次"这类词。',
          '3. 不超过 25 字，一句话，不要编号、不要引号、不要换行。',
          '4. 只输出这一句话，不要输出任何其他文字。'
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          '养护类型：' + typeLabel,
          context.species ? '植物：' + context.species : '',
          '用户勾选的内容：' + items.join('、')
        ].filter(Boolean).join('\n')
      }
    ]

    const content = await this.callChatModel(messages, 8000, '完成回执造句失败', {
      label: 'complete.echo'
    })

    return String(content || '')
      .trim()
      .replace(/^["「『]+|["」』]+$/g, '')
      .replace(/\s+/g, '')
      .slice(0, 30)
  }

  /**
   * 生成单项养护（浇水 / 施肥 / 打药 / 修剪）的完整操作方案，
   * 详细程度与用药指导保持一致，供提醒详情页展示。
   * 会带上品种知识库作为参考，保证药剂、浓度和间隔与知识库一致。
   */
  async generateCareDetail(plantInfo, reminder, options = {}) {
    this.assertAIConfigured()

    const species = plantInfo && (plantInfo.species || plantInfo.variety || plantInfo.name)
    const type = (reminder && reminder.type) || 'custom'
    const intervalDays = Number(reminder && reminder.interval_days) || 0

    const focus = {
      watering: [
        '1) 现在要不要浇水：给出可操作的判断标准，例如盆土表面发白、手指插进土里 2-3 厘米是干的、掂一掂花盆变轻。',
        '2) 具体怎么浇：浇多少水、浇在哪个位置、用什么工具、浇到盆底刚好流出水。',
        '3) 多久浇一次：说明和提醒间隔天数的关系，以及夏天、冬天、阴雨天怎么调整。',
        '4) 常见错误：最容易做错的 2-3 条，例如每天浇一点点、只浇湿表面、托盘长期积水，并说明后果。',
        '5) 浇完之后：怎么观察叶片和盆土状态，多久再看一次。'
      ],
      fertilizing: [
        '1) 现在要不要施肥：给出可操作的判断标准，例如正在长新叶、处于花期、还是休眠期。',
        '2) 怎么施肥：用什么类型的肥、稀释倍数、沿盆边浇还是埋肥、离茎干多远。',
        '3) 多久施一次：说明和提醒间隔天数的关系，以及生长期、高温期、休眠期怎么调整。',
        '4) 常见错误：最容易做错的 2-3 条，例如浓肥、干土施肥、刚换盆就施肥，并说明后果。',
        '5) 施完之后：怎么观察有没有肥害，多久再看一次。'
      ],
      pesticide: [
        '1) 现在要不要打药：区分预防性打药和发现病虫害后的治疗性打药，说明这次属于哪一种。',
        '2) 药怎么配：药剂名称、稀释倍数、家庭量具怎么量，并说明为什么选这类药。',
        '3) 怎么喷：喷施时间、重点部位、喷到什么程度，以及打药后多久不能浇水或淋雨。',
        '4) 安全注意：戴口罩手套、远离小孩和宠物、高温和雨天不打药等，说明原因。',
        '5) 打完怎么观察：怎么判断有没有药害，多久复查一次。'
      ],
      pruning: [
        '1) 现在要不要修剪：给出可操作的判断标准，例如枯叶、病叶、交叉过密的枝条。',
        '2) 怎么修剪：工具怎么消毒、从哪里下剪、一次剪掉多少、剪口要不要处理。',
        '3) 多久修剪一次：说明和提醒间隔天数的关系，以及生长期、花期、休眠期怎么调整。',
        '4) 常见错误：最容易做错的 2-3 条，例如剪刀不消毒、一次剪太狠、剪完不清理盆面，并说明后果。',
        '5) 剪完之后：怎么观察新芽，多久再看一次。'
      ]
    }[type]

    const typeLabel = {
      watering: '浇水',
      fertilizing: '施肥',
      pesticide: '打药',
      pruning: '修剪'
    }[type] || '养护'

    if (!focus) {
      const err = new Error('该提醒类型暂不支持生成 AI 详细方案')
      err.code = 'CARE_DETAIL_UNSUPPORTED'
      err.status = 400
      throw err
    }

    const profileLines = [
      `植物品种（以用户档案为准，不得更改）：${species || '未填写'}`,
      `植物名称：${(plantInfo && plantInfo.name) || '未填写'}`,
      `花盆：${(plantInfo && plantInfo.pot_size) || '未填写'}`,
      `土壤：${(plantInfo && plantInfo.soil_type) || '未填写'}`,
      `摆放位置：${(plantInfo && plantInfo.location) || '未填写'}`,
      `光照环境：${(plantInfo && plantInfo.light_environment) || '未填写'}`,
      `苗情阶段：${(plantInfo && plantInfo.growth_stage) || '未填写'}`,
      `来源：${(plantInfo && plantInfo.plant_source) || '未填写'}`,
      // 这个日期是"用户开始养它的日期"，网购/花市买回来时并不等于播种或扦插日期
      `开始养护日期（用户到手/开始养它的日期，不是播种日期，不能用来推算苗龄）：` +
        `${(plantInfo && plantInfo.planting_date) || '未填写'}`,
      `当前季节参考日期：${new Date().toISOString().slice(0, 10)}`
    ]

    // 缓苗期状态由服务端统一判定，直接告诉模型，避免它按日期自己推算并和提醒摘要打架
    const rest = restInfo(plantInfo)
    if (Number(plantInfo && plantInfo.is_recent_transplant)) {
      profileLines.push(rest.active
        ? `缓苗期：还没结束（刚换盆/刚移栽，到 ${rest.untilText} 结束）——这期间不要施肥，施肥方案里要明确说明`
        : '缓苗期：刚换盆/刚移栽的那段缓苗期已经结束，可以正常施肥')
    }

    const systemLines = [
      '你是一名家庭园艺植物医生，服务对象是中小学生和他们家里的盆栽。',
      '植物品种一律以用户提供的植物档案为准，不要更改植物品种。',
      `你现在只写“${typeLabel}”这一项的完整操作说明，它会出现在养护提醒的详情页里，用户会照着做。`,
      '请按下面的结构分点写，保留编号：',
      ...focus,
      '每点写 2-3 句话，全文 400-600 字，只需要写这一项，不要顺带讲其他养护动作。',
      '',
      // 块 3（2026-09-21）：除了正文，还要产出「完成面板」用的方案级候选 + 一句实时问题。
      // 口径来自用户：一条方案里有几个动作由板块内容自己决定，只要不过多。
      '输出格式（必须严格遵守）：只输出一个 JSON，不要输出其他文字，格式：',
      '{"detail":"完整操作说明，就是上面 1)-5) 那五点，按写法要求分段，不要写标题",' +
        '"options":["完成后最可能勾选的内容，2-4 个，按可能性从高到低"],' +
        '"ask":"这次完成时，就这份方案要问用户的一句实时问题"}',
      'options 的硬要求：只列**用户做完这次养护时，实际可能用到的具体东西、或做过的关键动作**，用来当勾选项。',
      '  写短标签（每个不超过 12 个字）：名词或短动宾，例如「花多多1号1000倍」「浇到盆底出水」「剪了枯枝病叶」。',
      '  不要写方案里的步骤、观察项、时间安排或下一步建议（「先浇清水润土再施肥」「施肥后看新芽」「停肥等花后再补」这些都不算）。',
      '  也不要写「等以后 / 下次 / 现蕾了再…」这类**现在还没发生**的动作——勾选项问的是"这次做了什么"。',
      '  不要写「肥料」「药」这种笼统词，也不要写成一句话。',
      '  正常情况至少给 2 个（这类方案里总会有具体的东西：肥/药的名字和浓度、浇到什么程度、剪了什么）；',
      '  只有整份方案确实没有具体内容时才返回空数组——但绝不许为了凑数编一个方案里没提过的东西。',
      'ask 的硬要求：问这份方案里的关键细节（例如「这次浇到盆底出水了吗？」「浓度是按说明配的吗？」），不要问常识。',
      '',
      ...WRITING_STYLE_RULES,
      ...PESTICIDE_SAFETY_RULES
    ]

    if (intervalDays > 0) {
      systemLines.splice(4, 0, `系统目前按大约 ${intervalDays} 天一次安排这条提醒，第 3 点要结合这个间隔说明。`)
    }

    // 品种知识库作为参考，保证 AI 方案里的药剂、浓度和间隔与知识库一致
    const careRule = knowledge.getCareRule(plantInfo && plantInfo.species, type)
    const environment = knowledge.getEnvironment(plantInfo && plantInfo.species)
    const knowledgeBlock = careRule && careRule.detail
      ? [
          `品种知识库参考（来自「${careRule.libraryLabel}」，同一品种的通用做法，`,
          '请保持其中的药剂名称、浓度倍数和间隔天数一致，',
          '再结合这盆植物的档案和当前季节补充更具体的说明）：',
          careRule.detail.slice(0, 1200)
        ].join('\n')
      : ''

    const environmentBlock = environment
      ? [
          '该品种的固有习性（同样来自知识库，用来判断当前做法是否合适）：',
          environment.light ? '光照：' + environment.light.slice(0, 300) : '',
          environment.temperature ? '温度：' + environment.temperature.slice(0, 300) : '',
          environment.dormancy ? '休眠：' + environment.dormancy.slice(0, 300) : ''
        ].filter(Boolean).join('\n')
      : ''

    // 施肥项额外带上施肥库的硬约束（浓度原则、禁施清单、混配禁忌）
    const fertilizingLines = []
    if (type === 'fertilizing') {
      const plan = knowledge.getFertilizingPlan(plantInfo && plantInfo.species)
      if (plan) {
        fertilizingLines.push(`施肥大类：${plan.groupCode} ${plan.groupName}（${plan.intensityText || '中等'}）`)
        if (plan.rhythm) fertilizingLines.push('该大类的施肥节奏：' + plan.rhythm)
        // 自制肥以前是中性列出来的，新手容易以为"要自己沤肥"；这里点明是备选
        if (plan.diy) fertilizingLines.push('家庭自制备选（想折腾再试，不是必须；要发酵、可能有味道，室内慎用）：' + plan.diy)
        if (plan.speciesNote) fertilizingLines.push('这个品种要特别注意：' + plan.speciesNote)
        if (plan.misconception) fertilizingLines.push('该大类最常见误区：' + plan.misconception)
      }
      // 买哪几包：把「小包装水溶肥优先、有机肥不是必需」这层讲清楚，
      // 否则模型容易顺手推荐一大包羊粪（用户 2026-09-21 的经验口径）
      const priorityLines = knowledge.describeFertilizingPriority()
      if (priorityLines.length) {
        fertilizingLines.push('')
        priorityLines.forEach((line) => fertilizingLines.push(line))
      }
      const rules = knowledge.describeFertilizingRules()
      if (rules.length) {
        fertilizingLines.push('')
        fertilizingLines.push('施肥硬约束（必须遵守，来自「施肥库」）：')
        rules.forEach((line) => fertilizingLines.push(line))
      }
    }

    // 购买指路：这条方案里会用到什么（药 / 肥 / 器械），就配对应的资料
    const detailGuideLines = knowledge.describePurchaseGuide(
      [...profileLines, knowledgeBlock, ...fertilizingLines].join('\n')
    )

    const messages = [
      {
        role: 'system',
        content: systemLines.join('\n')
      },
      {
        role: 'user',
        content: [
          ...profileLines,
          '',
          environmentBlock,
          environmentBlock ? '' : '',
          knowledgeBlock,
          ...fertilizingLines,
          options.feedback
            ? '用户觉得上一版方案有以下不合适的地方，请针对这些点重新安排，其余部分保持同样的详细程度：\n' +
              String(options.feedback).slice(0, 300)
            : '',
          ...(detailGuideLines.length ? [...detailGuideLines, ''] : []),
          `请给出这个品种的${typeLabel}完整操作说明。`
        ].join('\n')
      }
    ]

    const content = await this.callChatModel(messages, AI_TIMEOUT_MS, 'AI 养护方案生成失败', {
      label: 'reminder.detail',
      json: true
    })
    const result = this.parseCareDetailContent(content)

    if (!result.detail) {
      const err = new Error('Moonshot 未返回有效的养护方案')
      err.code = 'AI_EMPTY_RESULT'
      err.status = 502
      throw err
    }

    return result
  }

  /**
   * 块 3（2026-09-21）：把「完整操作方案」的返回拆成 { detail, options, ask }。
   *
   * 关键取舍：**模型偶尔不按 JSON 输出**（直接给正文，或者 JSON 坏了）。
   * 这时保留正文、候选留空——用老行为兜底，绝不因为格式没守住就让用户拿不到方案。
   * 调用方（routes/reminders.js）看到 options/ask 为空时也不会覆盖库里已有的候选。
   */
  parseCareDetailContent(content) {
    const raw = String(content || '').trim()
    let parsed = this.parseJsonContent(raw) || {}

    // 最常见的坏 JSON：字符串里带裸换行。修一下再解（见 repairJsonControlChars 的说明）
    if (!String(parsed.detail || '').trim()) {
      const repaired = this.parseJsonContent(repairJsonControlChars(raw)) || {}
      if (String(repaired.detail || '').trim()) parsed = repaired
    }

    // 结构实在坏了也要把正文抠出来：宁可少给候选，也不能把 JSON 原文当成方案给用户看
    if (!String(parsed.detail || '').trim()) {
      const detailMatch = raw.match(/"detail"\s*:\s*"([\s\S]*?)"\s*,\s*"(?:options|ask)"/)
      if (detailMatch) {
        parsed = Object.assign({}, parsed, { detail: unescapeJsonString(detailMatch[1]) })
      }
    }

    const detail = String(parsed.detail || '').trim()
    const options = (Array.isArray(parsed.options) ? parsed.options : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .filter((item, index, list) => list.indexOf(item) === index)
      .slice(0, 4)
    const ask = String(parsed.ask || '').trim().slice(0, 60)

    if (detail) return { detail, options, ask, structured: true }
    // 走到这里说明连"抠"都抠不出来：真·JSON 残片就别当正文用（让上层报错重试），
    // 不是 JSON 的话按老行为当正文（模型偶尔直接给正文）
    if (/^[{[]/.test(raw)) return { detail: '', options: [], ask: '', structured: false }
    return { detail: raw, options: [], ask: '', structured: false }
  }

  /** 当前板块的思考档位：disabled / low / high / max */
  thinkingLevelFor(label) {
    if (config.ai.thinkingOverride) return config.ai.thinkingOverride
    return THINKING_POLICY[label] || 'low'
  }

  /**
   * 组装请求体。两家都是 OpenAI 兼容接口，区别只在思考参数：
   *   DeepSeek：{"thinking":{"type":"enabled"/"disabled"}} + 顶层 reasoning_effort(low/high/max)
   *   Moonshot：{"thinking":{"type":"enabled"/"disabled"}}（K2.6 不支持分档；
   *             关闭思考时接口强制 temperature=0.6）
   * json=true 时要求模型输出 JSON 对象（DeepSeek 需要在提示词里出现 “json” 并给出示例，我们的提示词已满足）。
   */
  buildPayload(messages, { model, label, json, level } = {}) {
    const thinking = level || this.thinkingLevelFor(label)
    const provider = config.ai.provider
    const payload = {
      model: model || config.ai.model,
      messages,
      temperature: 1
    }

    const baseMaxTokens = MAX_TOKENS_POLICY[label]
    if (baseMaxTokens) {
      // 思考 token 与正文共用 max_tokens，所以要按档位追加预算
      payload.max_tokens = baseMaxTokens + (THINKING_BUDGET[thinking] || 0)
    }

    if (thinking === 'disabled') {
      payload.thinking = { type: 'disabled' }
      if (provider === 'moonshot') payload.temperature = 0.6
    } else {
      payload.thinking = { type: 'enabled' }
      if (['low', 'high', 'max'].includes(thinking)) {
        payload.reasoning_effort = thinking
      }
    }

    if (json) payload.response_format = { type: 'json_object' }

    return payload
  }

  async callChatModel(messages, timeoutMs, errorLabel, options = {}) {
    // 先看今天的额度：超了就不要再把请求发出去（发出去就是花钱）
    const budget = aiBudget.check()
    if (!budget.allowed) {
      const err = new Error(budget.message)
      err.code = 'AI_DAILY_LIMIT'
      err.status = 429
      throw err
    }

    const started = Date.now()
    const payload = this.buildPayload(messages, options)

    const response = await fetch(`${config.ai.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.apiKey}`
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    })

    const data = await response.json()

    const finishReason = data && data.choices && data.choices[0] ? data.choices[0].finish_reason : null

    aiMetrics.record({
      label: options.label || 'unknown',
      provider: config.ai.provider,
      model: payload.model,
      thinking: payload.thinking ? payload.thinking.type : null,
      effort: payload.reasoning_effort || null,
      maxTokens: payload.max_tokens || null,
      finishReason,
      ms: Date.now() - started,
      promptChars: aiMetrics.promptChars(messages),
      // 提示词指纹：只记不判，用来分辨"这条输出是不是新版本提示词跑的"
      promptHash: aiMetrics.promptHash(messages),
      outputChars: data && data.choices && data.choices[0] && data.choices[0].message
        ? String(data.choices[0].message.content || '').length
        : null,
      usage: data && data.usage ? data.usage : null,
      ok: Boolean(response.ok && !data.error),
      error: data && data.error ? String(data.error.message || data.error.code || '').slice(0, 200) : null
    })

    aiBudget.record()

    if (!response.ok || data.error) {
      const err = new Error((data.error && data.error.message) || errorLabel)
      err.code = data.error ? `AI_${data.error.code || 'ERROR'}` : 'AI_HTTP_ERROR'
      err.status = 502
      throw err
    }

    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
    if (!content) {
      // 思考模式下如果额度被思考吃光，就会"想完了没额度说话"：
      // 这时自动退回非思考模式重试一次，保证用户拿到可用结果（而不是整条流程失败）
      if (payload.thinking && payload.thinking.type === 'enabled' && !options.retriedWithoutThinking) {
        console.warn('[aiAdapter] ' + (options.label || 'unknown') +
          ' 思考占满额度（max_tokens=' + payload.max_tokens + '），改用非思考模式重试')
        return this.callChatModel(messages, timeoutMs, errorLabel, {
          ...options,
          level: 'disabled',
          retriedWithoutThinking: true
        })
      }

      const err = new Error(errorLabel + '（模型没有返回正文' +
        (payload.max_tokens ? '，可能是 max_tokens=' + payload.max_tokens + ' 被思考过程占满' : '') + '）')
      err.code = 'AI_EMPTY_RESULT'
      err.status = 502
      throw err
    }

    // 被 max_tokens 截断，和"思考吃光额度"是同一类故障：
    // 思考过程占了额度，正文写到一半就没预算了。
    // 所以同样退回非思考模式重试一次（2026-09-20 实测 treatment.consult 命中过：
    // max_tokens=10600 全被思考吃掉，正文截断成半截）。
    if (finishReason === 'length') {
      if (payload.thinking && payload.thinking.type === 'enabled' && !options.retriedWithoutThinking) {
        console.warn('[aiAdapter] ' + (options.label || 'unknown') +
          ' 输出被 max_tokens=' + payload.max_tokens + ' 截断，改用非思考模式重试')
        return this.callChatModel(messages, timeoutMs, errorLabel, {
          ...options,
          level: 'disabled',
          retriedWithoutThinking: true
        })
      }

      const err = new Error('AI 输出被截断（达到 max_tokens 上限），内容不完整')
      err.code = 'AI_OUTPUT_TRUNCATED'
      err.status = 502
      err.detail = String(content).slice(0, 200)
      throw err
    }

    return content
  }

  /**
   * 结构化输出的调用：解析失败（例如字符串里混了英文双引号、输出被截断）时，
   * 自动带一条纠正说明重试一次；仍然失败则由调用方显式报错，不会把半截 JSON 交给用户。
   */
  async callChatModelJson(messages, timeoutMs, errorLabel, options = {}) {
    const content = await this.callChatModel(messages, timeoutMs, errorLabel, options)
    let parsed = this.parseJsonContent(content)
    if (Object.keys(parsed).length) return { content, parsed }

    const retryMessages = messages.concat([{
      role: 'system',
      content: '上一次输出不是合法的 JSON（常见原因：字符串内部用了英文双引号，或内容被截断）。' +
        '请重新输出，必须是能被 JSON.parse 直接解析的合法 JSON；' +
        '字符串内部需要引号时一律使用中文引号「」，不要使用英文双引号，也不要输出 ``` 代码块。'
    }])

    const retried = await this.callChatModel(retryMessages, timeoutMs, errorLabel + '（格式纠正重试）', options)
    parsed = this.parseJsonContent(retried)
    return { content: retried, parsed, retried: true }
  }

  async diagnoseDiseaseWithVision(imageBase64, plantInfo) {
    this.assertAIConfigured()

    const species = plantInfo && (plantInfo.species || plantInfo.variety || plantInfo.name || '未知植物')
    const imageData = imageBase64.startsWith('data:')
      ? imageBase64
      : `data:image/jpeg;base64,${imageBase64}`

    const messages = [
      {
        role: 'system',
        content: [
          '你是一名家庭园艺植物医生。请根据用户提供的叶片照片，判断叶片是否存在病虫害，并给出结构化结论。',
          '植物品种已经由用户档案确定，不要根据照片更改植物品种，也不要输出植物品种名称。',
          '如果照片与该品种不符，仍然只判断叶片上的病虫害情况。',
          '只输出 JSON，不要输出其他文字。'
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              `该植物档案中登记的品种为：${species}（以下结论只针对这个品种，不要更改品种）`,
              '请判断照片中叶片是否存在病虫害。',
              '请严格按以下 JSON 格式输出：',
              '{"has_disease":true或false,"disease":"具体病虫害名称或空字符串","confidence":0到1之间的小数,"severity":"mild或moderate或severe或unknown","evidence":"简要判断依据，不超过60字"}'
            ].join('\n')
          },
          {
            type: 'image_url',
            image_url: {
              url: imageData
            }
          }
        ]
      }
    ]

    // 视觉复核走同一个适配层：模型用 visionModel，档位默认 low
    const content = await this.callChatModel(messages, 90000, 'AI 视觉诊断未返回有效结果', {
      label: 'diagnosis.vision',
      model: config.ai.visionModel,
      json: true
    })

    const parsed = this.parseJsonContent(content)
    return {
      has_disease: Boolean(parsed.has_disease),
      disease: parsed.disease || '',
      confidence: Number(parsed.confidence) || null,
      severity: this.normalizeSeverity(parsed.severity),
      evidence: parsed.evidence || '',
      raw: content
    }
  }

  async chat(plantInfo, messages, label, options = {}) {
    this.assertAIConfigured()
    return this.callChatModel(messages, AI_TIMEOUT_MS, 'AI 对话调用失败', {
      label: label || 'chat.generic',
      json: Boolean(options.json)
    })
  }

  /**
   * AI 精灵对话：结合植物档案、当前提醒、知识库与历史对话生成回复，
   * 需要修改数据时输出结构化的待确认变更。
   */
  async gardenerChat(plantInfo, context = {}, history = [], userMessage = '') {
    this.assertAIConfigured()

    const profileLines = Object.entries(context.profile || {})
      .filter(([, value]) => value)
      .map(([key, value]) => {
        // planting_date 的语义是"用户开始养它的日期"，不是播种日期，
        // 不能拿它推算苗龄或缓苗期（否则会和提醒里的缓苗期状态打架）
        if (key === 'planting_date') return `开始养护日期（到手/开始养它的日期，不是播种日期）：${value}`
        const label = { growth_stage: '苗情阶段', plant_source: '来源' }[key] || key
        return `${label}：${value}`
      })

    const transplantLines = []
    if (context.transplant && context.transplant.flagged) {
      transplantLines.push(context.transplant.active
        ? `缓苗期还没结束（刚换盆/刚移栽，到 ${context.transplant.until || context.transplant.untilText} 结束），这期间不要施肥`
        : '刚换盆/刚移栽的那段缓苗期已经结束，可以按正常节奏养护')
    }

    // 浇水单独用天气模型的数字，避免同一件事出现两套天数
    const reminderLines = (context.reminders || [])
      .filter((item) => !(item.type === 'watering' && context.watering))
      .map((item) => `${item.title}（${item.type}）：每 ${item.interval_days || '—'} 天，下一次 ${item.due_at}`)

    const wateringLines = []
    if (context.watering) {
      const w = context.watering
      wateringLines.push(`下一次浇水日期：${w.next_due_date || '—'}`)
      if (w.interval_days) wateringLines.push(`这盆植物当前按每 ${w.interval_days} 天浇一次安排`)
      if (w.corrected) {
        wateringLines.push(`（天气模型单独算出的是每 ${w.model_interval_days} 天，知识库标准是每 ` +
          `${w.knowledge_interval_days} 天，两者差距较大，已按 0.7×天气模型 + 0.3×知识库 折中）`)
      }
      if (w.et0) wateringLines.push(`当地当前蒸发量约 ${w.et0} mm/天`)
      if (w.city) wateringLines.push(`天气来源：${w.city}`)
      if (w.exposure || w.soil) wateringLines.push(`摆放与基质：${w.exposure || '—'}｜${w.soil || '—'}`)
      if (w.tank_percent !== undefined && w.tank_percent !== null) {
        wateringLines.push(`土壤水分账户剩余约 ${w.tank_percent}%`)
      }
    }

    const careLines = (context.careRules || []).map((rule) =>
      `【${rule.library}】${rule.type}：标准间隔 ${rule.interval_days} 天；${rule.note}\n${rule.detail}`
    )

    const extraLines = []
    if (context.disease) {
      extraLines.push(`命中的病虫害档案（${context.disease.code} ${context.disease.entry.name}）：` +
        `识别 ${context.disease.entry.symptom || ''}｜预防 ${knowledge.describeScheme(context.disease, 'prevention')}｜` +
        `轻度 ${knowledge.describeScheme(context.disease, 'mild')}｜中重度 ${knowledge.describeScheme(context.disease, 'severe')}`)
    }
    if (context.purpose) {
      extraLines.push(`命中的施肥用途（${context.purpose.code} ${context.purpose.name}）：` +
        `判断 ${context.purpose.signal || ''}｜成品方案 ${context.purpose.product_plan || context.purpose.plan || ''}｜` +
        `注意 ${context.purpose.note || ''}`)
    }
    // 用户问「该买什么肥 / 要不要买羊粪」时，按用途给出档位（第 1 档一包就够）
    if (context.purpose || /肥|施肥/.test(userMessage)) {
      const priorityLines = knowledge.describeFertilizingPriority({
        purpose: context.purpose && context.purpose.code
      })
      priorityLines.forEach((line) => extraLines.push(line))
    }
    for (const doc of context.docs || []) {
      extraLines.push(`补充资料《${doc.title}》：${String(doc.content).slice(0, 300)}`)
    }

    // 购买指路：用户很可能在对话里直接问「这个去哪儿买」。
    // 用户这句话里的物品要优先占名额，否则会被知识库里先出现的药挤掉（实测踩过）。
    const chatGuideLines = knowledge.describePurchaseGuide(
      [userMessage, ...careLines, ...extraLines].join('\n'),
      { priorityText: userMessage }
    )

    const systemLines = [
      '你是「托蕾妮」，一名懂家庭园艺的养护助手，服务对象是中小学生和他们家里的盆栽。',
      '讲话要亲切、口语化，像有经验的花友面对面分享，不要学术腔。',
      '沟通流程：先弄清植株和环境情况 → 信息不足就继续问 → 再给出判断和处理方案 → 涉及改数据先征求同意。',
      '',
      '严格遵守下面的规则：',
      '1. 植物品种一律以档案为准，不要更改品种，也不要编造档案里没有的信息。',
      '2. 药剂、浓度、间隔天数必须来自上面提供的知识库内容，不要自己发明；知识库没有覆盖的再按常识回答，并说明是经验建议。',
      '   提到浇水间隔时，只能引用【浇水节奏】里的数字（那已经结合当地天气算好），不要另算一个天数，也不要说档案里是别的天数。',
      '3. 先给建议，再谈改数据：用户只是在陈述现状时（例如“我家光照每天只有 4 小时”“阳台朝北”），',
      '   要先给出适应现状的养护办法，不要马上提出用户可能做不到的改动（例如换房间、换朝向、搬到南阳台）。',
      '   遇到这类难以改变的硬条件，可以说明“如果能调整会更好”，并给出替代做法（补光、换耐阴品种、调整浇水与施肥节奏）。',
      '   只有用户明确表示“我愿意 / 我准备 / 我可以”调整某个条件时，才把对应的档案修改放进 proposed_changes。',
      '4. 任何对植物档案或提醒的修改，都必须放进 proposed_changes 里征求同意，',
      '   绝对不能在回复里写“已经帮你改好了”。',
      '5. proposed_changes 只允许两种：',
      '   - 修改档案：{"change_type":"profile","field":"location","value":"南阳台","label":"把摆放位置改成南阳台"}',
      '     field 只能是 variety / pot_size / soil_type / location / light_environment / notes / planting_date。',
      '   - 调整提醒：{"change_type":"reminder","reminder_type":"watering","interval_days":5,"label":"把浇水改成每 5 天一次"}',
      '     reminder_type 只能是 watering / fertilizing / pesticide / pruning，interval_days 在 1–180 之间。',
      '6. 用户明确要求修改时，也要先确认再改；没有修改需求就让 proposed_changes 为空数组。',
      '7. 用户明确要求调整某条提醒的频率时（例如「以后每 5 天提醒我浇一次水」），',
      '   即使你认为这个节奏不理想，也要先用一句话说明风险，然后把修改放进 proposed_changes 让用户确认；',
      '   不要只停在口头劝阻，也不要直接说"已经帮你改好了"。',
      '8. JSON 字符串内部不要使用英文双引号，需要引用时一律用中文引号「」；输出必须能被 JSON.parse 直接解析。',
      '',
      // 2026-09-20 批注 6：765 字的回复学生看不完。
      // 压制的是"把知识库念一遍"的倾向，安全例外单独留口子，防止为了短把安全删掉。
      '9. reply 的长度与取舍（和下面的写法要求同等重要）：',
      '   先给结论，不超过 30 字；最多写 3 个要点，每个要点不超过 60 字；整条 reply 不超过 300 字。',
      '10. 只讲用户这次问的这件事，再加现在最要紧的一件事；知识库里其余的内容留到用户追问时再说，',
      '   不要把知道的一次讲完。',
      '11. 用户问的是「要不要改」这类是非题时，第一句必须明确回答「要改」或「不用改」，再讲理由。',
      '12. 涉及用药安全、中毒风险、孩子与宠物、急救、**有毒药品的购买要求**的内容不受字数限制，必须说全；',
      '   这类 reply 在开头加一句「先把安全的事说完」。',
      '13. 结尾最多写一句引导（例如「想知道具体怎么补光，我再展开」），不要重复已经说过的内容。',
      // 块 4（2026-09-21）：对话以前看不到"用户刚完成过什么"，会答"我查不到"
      '14. 【最近发生的事】里是这盆植物**已经发生**的记录（含用户完成时勾选的"实际用了什么"）。',
      '   用户问「我上次做了什么 / 用的什么肥 / 打的是什么药」这类问题时，只按这里回答，',
      '   可以顺手把日期和当时勾的具体名字说出来。标了「实际做了什么未登记」的，就如实说那一次没有登记，',
      '   不要照方案或常识替他补一个具体的药名肥名；查不到就说查不到。',
      '   （连「比如花多多1号」这种举例也尽量避免——学生容易看成"你说的就是他用的"。）',
      '   用户说的和记录不一致时，以用户这次说的为准，同时说明记录里当时登记的是另一种，不要反驳他。',
      '',
      '只输出一个 JSON，不要输出其他文字，格式：',
      '{"reply":"给用户的回复","proposed_changes":[],"need_confirm":false}',
      '',
      ...WRITING_STYLE_RULES,
      ...PESTICIDE_SAFETY_RULES
    ]

    const contextLines = [
      '【这盆植物的档案】',
      ...(profileLines.length ? profileLines : ['（档案信息很少，可以先问用户）']),
      '',
      // 块 4：让对话看到"已经发生的事"，别让用户觉得"记了却查不到"
      ...((context.recentActivity && context.recentActivity.lines.length)
        ? ['【最近发生的事（已经发生的记录，不是知识库、也不是计划）】',
          ...context.recentActivity.lines, '']
        : ['【最近发生的事】（暂时没有完成记录，也没写过日记）', '']),
      '【当前的养护提醒】',
      ...(reminderLines.length
        ? reminderLines
        : (wateringLines.length ? ['（浇水见下面的浇水节奏，其余暂时没有提醒）'] : ['（暂时没有提醒）'])),
      '',
      ...(wateringLines.length ? ['【浇水节奏（以当地天气模型为准，这些数字是最终结论）】', ...wateringLines, ''] : []),
      ...(transplantLines.length ? ['【缓苗期状态】', ...transplantLines, ''] : []),
      '【知识库】',
      ...careLines,
      ...extraLines,
      ...(chatGuideLines.length ? ['', ...chatGuideLines] : []),
      '',
      context.environment
        ? '【该品种习性】光照：' + String(context.environment.light || '').slice(0, 200) +
          '；温度：' + String(context.environment.temperature || '').slice(0, 200)
        : ''
    ].filter(Boolean)

    const messages = [
      { role: 'system', content: systemLines.join('\n') }
    ]

    if (context.summary) {
      messages.push({ role: 'system', content: '之前的对话摘要：' + context.summary })
    }

    for (const item of history) {
      messages.push({
        role: item.role === 'assistant' ? 'assistant' : 'user',
        content: String(item.content || '').slice(0, 800)
      })
    }

    messages.push({
      role: 'user',
      content: [...contextLines, '', '【用户这次的问题】', userMessage].join('\n')
    })

    const { content, parsed } = await this.callChatModelJson(messages, AI_TIMEOUT_MS, 'AI 对话调用失败', {
      label: 'chat.gardener',
      json: true
    })

    const reply = String(parsed.reply || '').trim()
    if (!reply) {
      // 走到这里说明 JSON 没解析出 reply。如果原文本身像是（半截的）JSON，
      // 绝不能把结构原文丢给用户看，按"AI 出错"显性报错，让前端提示重试。
      const looksLikeJson = /^\s*[{[]/.test(content) || /"proposed_changes"|"reply"\s*:/.test(content)
      if (looksLikeJson) {
        const err = new Error('AI 返回的对话内容格式不完整，请重试')
        err.code = 'AI_INVALID_CHAT_JSON'
        err.status = 502
        err.detail = String(content).slice(0, 200)
        throw err
      }
      // 确实不是 JSON（例如模型直接说了人话），把原文当回复，不产生任何数据变更
      return { reply: String(content || '').trim(), proposed_changes: [], need_confirm: false, raw: true }
    }

    const changes = Array.isArray(parsed.proposed_changes)
      ? parsed.proposed_changes.filter((item) => item && item.change_type)
      : []

    return {
      reply,
      proposed_changes: changes,
      need_confirm: Boolean(parsed.need_confirm) || changes.length > 0
    }
  }

  /** 对话历史压缩：把较早的消息总结成一段摘要 */
  async summarizeChat(previousSummary, rows) {
    this.assertAIConfigured()

    const transcript = rows
      .map((row) => (row.role === 'assistant' ? '托蕾妮：' : '用户：') + String(row.content).slice(0, 300))
      .join('\n')

    const messages = [
      {
        role: 'system',
        content: [
          '你在整理一段家庭园艺助手与用户的对话记录。',
          '请把关键信息压缩成不超过 200 字的摘要，保留：植物当前的状况、已经给过什么建议、',
          '用户做过或答应过的养护动作、尚未解决的问题。不要写客套话，不要分点，直接给一段话。'
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          previousSummary ? '之前的摘要：' + previousSummary : '',
          '需要整理的新对话：',
          transcript
        ].filter(Boolean).join('\n')
      }
    ]

    const content = await this.callChatModel(messages, AI_TIMEOUT_MS, 'AI 对话摘要失败', {
      label: 'chat.summarize'
    })
    return String(content || '').trim().slice(0, 500)
  }

  async getBaiduAccessToken() {
    const url = new URL('https://aip.baidubce.com/oauth/2.0/token')
    url.searchParams.set('grant_type', 'client_credentials')
    url.searchParams.set('client_id', config.baidu.apiKey)
    url.searchParams.set('client_secret', config.baidu.secretKey)

    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(15000)
    })
    const data = await response.json()

    if (!response.ok || !data.access_token) {
      const err = new Error(data.error_description || '获取百度 access_token 失败')
      err.code = data.error ? `BAIDU_AUTH_${data.error}` : 'BAIDU_AUTH_ERROR'
      err.status = 502
      throw err
    }

    return data.access_token
  }

  inferDisease(name) {
    if (!name) return ''
    if (/病|虫|粉|斑|霉|腐|蚧|螨|菌|枯|黄|烂|萎|锈/i.test(name)) {
      return name
    }
    return ''
  }

  normalizeSeverity(value) {
    const raw = String(value || '').toLowerCase().trim()
    if (raw === 'mild' || raw === 'moderate' || raw === 'severe') {
      return raw
    }
    return 'unknown'
  }

  parseJsonContent(content) {
    const text = String(content || '').trim()
    if (!text) return {}

    // 1) 直接解析
    try {
      return JSON.parse(text)
    } catch (e) {
      // 继续尝试下面几种常见变形
    }

    // 2) 去掉 ```json ... ``` 包裹
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fenced) {
      try {
        return JSON.parse(fenced[1].trim())
      } catch (e) {
        // 落到下面的括号扫描
      }
    }

    // 3) 括号配对截取 + 截断修补（DeepSeek 的 JSON 模式偶发空内容/截断，
    //    这里尽量抢救，救不回来再返回空对象由调用方显式报错）
    const snippet = this.extractJsonObject(fenced ? fenced[1] : text)
    if (snippet) {
      try {
        return JSON.parse(snippet)
      } catch (e) {
        const repaired = this.repairTruncatedJson(snippet)
        if (repaired) {
          try {
            return JSON.parse(repaired)
          } catch (e2) {
            // 修不回来就按空对象处理
          }
        }
      }
    }

    return {}
  }

  /** 截出第一个完整的 JSON 对象（按括号配对，正确处理嵌套与多余后缀） */
  extractJsonObject(text) {
    const source = String(text || '')
    const start = source.indexOf('{')
    if (start < 0) return ''

    let depth = 0
    let inString = false
    let escaped = false

    for (let i = start; i < source.length; i++) {
      const char = source[i]

      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }

      if (char === '"') inString = true
      else if (char === '{') depth++
      else if (char === '}') {
        depth--
        if (depth === 0) return source.slice(start, i + 1)
      }
    }

    return source.slice(start)
  }

  /** 修补被截断的 JSON：补上未闭合的字符串、数组与对象 */
  repairTruncatedJson(text) {
    const source = String(text || '')
    let inString = false
    let escaped = false
    const stack = []

    for (let i = 0; i < source.length; i++) {
      const char = source[i]

      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }

      if (char === '"') inString = true
      else if (char === '{' || char === '[') stack.push(char === '{' ? '}' : ']')
      else if (char === '}' || char === ']') stack.pop()
    }

    let repaired = source.replace(/,\s*$/, '')
    if (inString) repaired += '"'
    repaired = repaired.replace(/,\s*"[^"]*$/, '')
    while (stack.length) repaired += stack.pop()

    return repaired === source ? '' : repaired
  }

  assertBaiduConfigured() {
    if (!config.baidu.apiKey || !config.baidu.secretKey) {
      const err = new Error('百度植物识别未配置，请检查 BAIDU_API_KEY 和 BAIDU_SECRET_KEY')
      err.code = 'AI_NOT_CONFIGURED'
      err.status = 503
      throw err
    }
  }

  assertAIConfigured() {
    if (!config.ai.apiKey) {
      const err = new Error('AI 未配置，请检查 AI_API_KEY（当前供应商：' + config.ai.provider + '）')
      err.code = 'AI_NOT_CONFIGURED'
      err.status = 503
      throw err
    }
  }
}

module.exports = new AIAdapter()
