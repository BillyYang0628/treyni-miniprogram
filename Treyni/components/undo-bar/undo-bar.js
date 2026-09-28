/**
 * 完成后的撤销条。
 *
 * 完成一个提醒会连带生成下一轮、写养护历程、写浇水事件，
 * 撤销走的是服务端的"整行快照回滚"（见 server/src/services/undoStore.js）。
 * 这里只负责显示倒计时和把撤销意图抛给页面。
 */
Component({
  properties: {
    show: {
      type: Boolean,
      value: false
    },
    seconds: {
      type: Number,
      value: 5
    }
  },

  data: {
    left: 5
  },

  observers: {
    show: function (show) {
      if (!show) {
        this.stopTimer()
        return
      }
      this.setData({ left: this.data.seconds })
      this.startTimer()
    }
  },

  detached() {
    this.stopTimer()
  },

  methods: {
    startTimer() {
      this.stopTimer()
      this.timer = setInterval(() => {
        const left = this.data.left - 1
        if (left <= 0) {
          this.stopTimer()
          this.triggerEvent('expire')
        } else {
          this.setData({ left })
        }
      }, 1000)
    },

    stopTimer() {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    },

    onUndo() {
      this.stopTimer()
      this.triggerEvent('undo')
    }
  }
})
