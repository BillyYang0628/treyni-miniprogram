/**
 * 底部面板外壳。
 *
 * 只负责"弹出"这件事：遮罩、上滑动画、高度上限、内部滚动、底部安全区、按钮栏。
 * 内容通过 slot 塞进来，所以完成面板、计划面板、以后重写"重新生成方案"都用它。
 *
 * 单独抽出来的原因：滚动穿透（面板开着时底下的页面跟着滚）自己写很容易漏，
 * 这里统一用 catchtouchmove 挡在遮罩上，下面各个面板不用各写一遍。
 */
Component({
  options: {
    multipleSlots: true
  },

  properties: {
    show: {
      type: Boolean,
      value: false
    },
    title: {
      type: String,
      value: ''
    }
  },

  methods: {
    onClose() {
      this.triggerEvent('close')
    },

    // 遮罩上吃掉 touchmove，阻止底下的页面跟着滚
    blockMove() {}
  }
})
