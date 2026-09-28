/**
 * AI 文本渲染：分段 + 重点高亮。
 *
 * 为什么需要（批注 2）：AI 生成的病害介绍、用药指导以前都是**一大段**，
 * 400 多字挤在一起，学生根本读不完。提示词那头加了分段要求（见 aiAdapter 的 WRITING_STYLE_RULES 第 9-11 条），
 * 这个组件负责两件事：
 *   1. 按空行切段，一段一个 <view>，段与段之间留间距；
 *   2. 按**规则**给重点着色/加粗——不让模型输出任何标记。
 *
 * 为什么用规则高亮而不是让模型打标记：
 *   - 对已经存在库里的历史文本同样生效，不用重跑 AI；
 *   - 不依赖模型的遵守率；
 *   - 出问题只改前端，不动提示词。
 *
 * 为什么不用 rich-text：要自己转义、样式控制弱，而且项目里零先例。
 * 小程序支持 <text> 里再嵌 <text> 各自设样式，够用。
 */

const { buildBlocks } = require('../../utils/aiText')

Component({
  properties: {
    text: {
      type: String,
      value: ''
    },
    // default 正文色 / warn 警示红（放在浅红底上时用）/ inverse 白字（深色气泡上）
    tone: {
      type: String,
      value: 'default'
    }
  },

  data: {
    blocks: []
  },

  observers: {
    text: function (text) {
      this.setData({ blocks: buildBlocks(text) })
    }
  }
})
