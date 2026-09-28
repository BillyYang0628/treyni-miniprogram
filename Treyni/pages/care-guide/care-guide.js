const GUIDE = require('./care-guide-data')

/**
 * 长内容统一按“折叠卡片”展示：每个三级标题（含它下面的段落、列表、表格）
 * 归为一张可下拉的大框，默认只展开第一张，页面不会一屏铺满文字。
 * 四个字段各有独立入口，页面只渲染传进来的那一个版块，不做版块切换。
 */
function buildGroups(blocks) {
  const groups = []
  let current = { title: '先看这里', blocks: [] }

  for (const block of blocks) {
    if (block.type === 'h3') {
      if (current.title || current.blocks.length) groups.push(current)
      current = { title: block.text, blocks: [] }
      continue
    }
    current.blocks.push(block)
  }

  if (current.title || current.blocks.length) groups.push(current)

  return groups.map((group, index) => ({
    ...group,
    key: index,
    open: index === 0,
    hint: buildHint(group)
  }))
}

/** 折叠时显示一句摘要，让用户知道里面讲了什么 */
function buildHint(group) {
  const paragraph = group.blocks.find((block) => block.type === 'p' && block.text)
  if (paragraph) return paragraph.text.slice(0, 42) + (paragraph.text.length > 42 ? '…' : '')

  const table = group.blocks.find((block) => block.type === 'table')
  if (table) return `共 ${table.rows.length} 行对照表，点开查看`

  const list = group.blocks.find((block) => block.type === 'ul' || block.type === 'ol')
  if (list) return `共 ${list.items.length} 条要点，点开查看`

  return ''
}

Page({
  data: {
    activeKey: 'pot_size',
    title: '',
    blocks: [],
    groups: [],
    allOpen: false
  },

  onLoad(options) {
    const key = options.section && GUIDE[options.section] ? options.section : 'pot_size'
    this.showSection(key)
  },

  showSection(key) {
    const section = GUIDE[key]
    if (!section) return

    this.setData({
      activeKey: key,
      title: section.title,
      blocks: section.blocks,
      groups: buildGroups(section.blocks),
      allOpen: false
    })

    wx.setNavigationBarTitle({ title: section.title })
  },

  onToggleGroup(event) {
    const index = Number(event.currentTarget.dataset.index)
    const groups = this.data.groups.map((group, i) =>
      i === index ? { ...group, open: !group.open } : group
    )
    this.setData({ groups })
  },

  onToggleAll() {
    const allOpen = !this.data.allOpen
    this.setData({
      allOpen,
      groups: this.data.groups.map((group) => ({ ...group, open: allOpen }))
    })
  },

  goBack() {
    wx.navigateBack({
      fail() {
        wx.switchTab({ url: '/pages/garden/garden' })
      }
    })
  }
})
