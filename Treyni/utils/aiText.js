/**
 * AI 文本的分段与重点识别（纯函数，供 components/ai-text 使用）。
 *
 * 为什么单独放 utils 而不是写在组件里：
 *   组件文件没法被验证脚本 require，逻辑放这里才能写单测。
 *   分段/高亮是"改完看不出对错"的那类逻辑，必须有断言兜着。
 *
 * 高亮为什么用规则而不是让模型打标记（方案 B-3 决策点 1）：
 *   - 对已经存在库里的历史文本同样生效，不用重跑 AI；
 *   - 不依赖模型遵守率；
 *   - 出问题只改前端，不动提示词。
 */

// 安全警示：这几类词出现的地方一定要让人看见
const SAFETY_RE = /切记|别踩坑|不要|禁止|中毒|药害|烧根|远离儿童|家长|戴好口罩|戴手套/
// 结论句：AI 被要求把结论放开头，开头这几句要突出
const CONCLUSION_RE = /^\s*(先说结论|简单说|一句话|结论)/
// 关键剂量：数字 + 单位
const DOSE_RE = /\d[\d.]*\s*(倍|克|g|毫升|ml|升|L|℃|度|厘米|cm|天|次)/

// 一屏最多高亮几处。满屏红反而没有重点（方案 B-3 里定的 3-5 处）
const MAX_HIGHLIGHT = 5
// 其中安全警示/结论至少占几处。
// 为什么不能"先到先得"：实测一条 887 字的打药方案里剂量句排在前面，
// 5 个额度全被剂量吃掉，后面那句「切记」反而没轮上——安全必须比剂量优先。
const MAX_SAFETY = 3

// 单段超过这个长度就尝试硬切。120 字在手机上大约 5 行，
// 再长就属于"一坨"了（初版定 200 偏保守，167 字的病害介绍就漏过去了）
const BLOB_THRESHOLD = 120

/** 切段：优先按换行；模型没换行时退回按 ①②③ 切，再不行按句号硬切 */
function splitParagraphs(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim()
  if (!raw) return []

  const parts = raw.split(/\n+/).map((item) => item.trim()).filter(Boolean)
  if (parts.length > 1) return parts

  if (parts[0].length > BLOB_THRESHOLD) {
    const byNumber = parts[0].split(/(?=[①②③④⑤⑥⑦⑧⑨⑩])/).map((item) => item.trim()).filter(Boolean)
    if (byNumber.length > 1) return byNumber

    // 连编号都没有：按句号硬切，每 2 句一段，至少别让它是一坨
    const sentences = parts[0].match(/[^。！？]*[。！？]?/g) || [parts[0]]
    const merged = []
    for (let i = 0; i < sentences.length; i += 2) {
      const chunk = (sentences[i] + (sentences[i + 1] || '')).trim()
      if (chunk) merged.push(chunk)
    }
    if (merged.length) return merged
  }

  return parts
}

/** 把一个段落切成句子（保留标点） */
function splitSentences(paragraph) {
  return (paragraph.match(/[^。；！？]*[。；！？]?/g) || [paragraph]).filter(Boolean)
}

/**
 * 全篇按"两遍"决定哪句高亮：
 *   第一遍只挑安全警示和结论句（最多 MAX_SAFETY 处）；
 *   第二遍把剩下的额度给关键剂量。
 * 一遍扫下来"先到先得"会让长方案里的安全提醒被剂量挤掉，见上面 MAX_SAFETY 的说明。
 */
function markSentences(paragraphs) {
  const sentences = paragraphs.map(splitSentences)
  const marks = sentences.map((list) => list.map(() => ''))
  let safety = MAX_SAFETY
  let left = MAX_HIGHLIGHT

  for (let i = 0; i < sentences.length; i++) {
    for (let j = 0; j < sentences[i].length; j++) {
      if (safety > 0 && (SAFETY_RE.test(sentences[i][j]) || CONCLUSION_RE.test(sentences[i][j]))) {
        marks[i][j] = 'ai-warn'
        safety--
        left--
      }
    }
  }

  for (let i = 0; i < sentences.length; i++) {
    for (let j = 0; j < sentences[i].length; j++) {
      if (!marks[i][j] && left > 0 && DOSE_RE.test(sentences[i][j])) {
        marks[i][j] = 'ai-strong'
        left--
      }
    }
  }

  return { sentences, marks }
}

function buildBlocks(text) {
  const paragraphs = splitParagraphs(text)
  const { sentences, marks } = markSentences(paragraphs)

  return paragraphs.map((paragraph, index) => {
    const list = sentences[index]
    const segs = []
    for (let i = 0; i < list.length; i++) {
      if (list[i]) segs.push({ text: list[i], cls: marks[index][i] || '' })
    }
    return { segs: segs.length ? segs : [{ text: paragraph, cls: '' }] }
  })
}

module.exports = {
  MAX_HIGHLIGHT,
  MAX_SAFETY,
  BLOB_THRESHOLD,
  splitParagraphs,
  splitSentences,
  markSentences,
  buildBlocks
}
