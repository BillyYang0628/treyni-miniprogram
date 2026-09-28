/**
 * 完成登记面板。
 *
 * 第一期只做两件事：**这次做了什么** + **实际是哪天做的**。
 * 档位题（太早二选一、逾期原因）留到第三期，届时按"恒定 ≤2 个问题块"的约束加。
 *
 * 三条来自《每日提醒阈值方案.md》第八节的硬规矩，这里必须守住：
 *   1. 候选个数别把面板撑得比题目还高（动态 ≤ 4 + 固定的「用了别的」「说不清」= 最多 6 格）；
 *   2. 每个多选里都有「说不清 / 我忘了」，而且**允许一题不选直接提交**；
 *   3. **跳过 ≠ 按方案做了**——没选就记"未登记"，绝不默认用户照方案执行了。
 *
 * 面板的第一价值不是收集素材，而是**防止把没做的事记成做了**。
 */

const { ICONS } = require('../../utils/icons')
const { request } = require('../../utils/request')

/**
 * B-2：提交时给勾选项配一句"我说的话"（气泡动画）。
 *
 * 时序（重点是**绝不卡住提交流程**）：
 *   1. 点完成的瞬间就用本地拼接的那句把气泡显示出来 —— 动画不依赖网络；
 *   2. 同时后台请 AI 把勾选项说成一句人话，先回来就先换上去；
 *   3. 不管 AI 回来没有，等满 ECHO_HOLD_MS 就提交，超时/失败静默用本地那句。
 *
 * 为什么本地那句必须是"能独立成立"的：AI 没配、断网、超时的时候，
 * 用户看到的就只有这一句，不能是半成品。
 */
// 实测造句接口 370-820 ms（thinking disabled、max_tokens 120），
// 所以窗口留 1.2 秒：AI 基本都能赶上，赶不上就用本地那句，用户感知不到差别。
// 前端请求超时比这个窗口稍长一点，免得多打一次没必要的请求。
const ECHO_HOLD_MS = 1200
const ECHO_TIMEOUT_MS = 1500

/**
 * 动态候选上限：**方案需要几个就显示几个**，只要别把面板撑得比题目还高。
 *
 * 2026-09-21 用户拍板放宽：原来死守"动态最多 2 个"是为了给「用了别的」「说不清」留格子，
 * 结果方案明明产出了 3-4 个具体候选，面板只显示前 2 个。现在的口径是
 * 「规则要符合需求」——动态最多 4 个（+ 固定两格 = 6 格，两列排三行），超出的才折进「用了别的」。
 * 「说不清」始终保留（那是数据质量的底线，不是布局问题）。
 */
const MAX_DYNAMIC_OPTIONS = 4

// 第一期先用按类型固定的候选；第五期会换成"物种级 + 方案级"生成的候选
const OPTION_TABLE = {
  watering: {
    multi: false,
    question: '这次浇到什么程度？',
    options: [
      { value: 'soaked', label: '浇透了' },
      { value: 'little', label: '只浇了一点' },
      { value: 'rinse', label: '只冲了叶片' },
      { value: 'unsure', label: '说不清' }
    ]
  },
  fertilizing: {
    multi: true,
    question: '这次用了什么？',
    options: [
      { value: 'as_planned', label: '按方案施的肥' },
      { value: 'partial', label: '只施了一部分' },
      { value: 'other', label: '用了别的肥（补充里写）' },
      { value: 'unsure', label: '说不清' }
    ]
  },
  pesticide: {
    multi: true,
    question: '这次用了什么？',
    options: [
      { value: 'as_planned', label: '按方案打的药' },
      { value: 'partial', label: '只打了一部分' },
      { value: 'other', label: '用了别的药（补充里写）' },
      { value: 'unsure', label: '说不清' }
    ]
  },
  pruning: {
    multi: true,
    question: '这次剪了什么？',
    options: [
      { value: 'dead_leaf', label: '剪了枯枝病叶' },
      { value: 'dense', label: '剪了过密枝' },
      { value: 'pinch', label: '摘心 / 打顶' },
      { value: 'unsure', label: '说不清' }
    ]
  },
  default: {
    multi: true,
    question: '这次做了什么？',
    options: [
      { value: 'done', label: '按计划做了' },
      { value: 'partial', label: '只做了一部分' },
      { value: 'other', label: '做了别的（补充里写）' },
      { value: 'unsure', label: '说不清' }
    ]
  }
}

// 安全提示常驻在提交按钮上方：安全该每次都显示，不是问一次
const SAFETY_TEXT = {
  pesticide: '打药请由家长操作。戴口罩和手套，孩子不要接触原药。',
  fertilizing: '施肥后浇一次透水，避免浓度过高伤根。',
  watering: '浇到盆底有水流出就可以，别让托盘长期积水。',
  pruning: '剪刀用前先消毒，剪下的枝叶及时清理。'
}

const MAX_DAYS_BACK = 7

// 迟做的原因。按《措辞规范》：选项本身不带责备（"最近没顾上"而不是"忘了"）。
const LATE_OPTIONS = [
  { key: 'forgot', label: '最近没顾上' },
  { key: 'weather', label: '天气不合适' },
  { key: 'already_done', label: '其实已经做过了' },
  { key: 'not_needed', label: '这段时间不需要做' },
  { key: 'other', label: '其他原因' }
]

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function dateString(date) {
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

function friendlyDate(value, today) {
  if (!value) return ''
  if (value === today) return '今天'
  const matched = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return matched ? Number(matched[2]) + ' 月 ' + Number(matched[3]) + ' 日' : value
}

/** 取 ISO 时间在**本地时区**的那一天（slice(0,10) 拿到的是 UTC 日期，会差一天） */
function localDayOf(iso) {
  if (!iso) return ''
  return dateString(new Date(iso))
}

/**
 * 拼候选：方案级 → 物种级 → 兜底表。
 *
 * 两层来源的分工（第 5 期）：
 *   方案级 reminder.options：这条方案里真的会出现的选择，由生成方案时的 AI 产出
 *   物种级 reminder.care_options：这个品种常见的药/肥，添加植物时生成一次、同品种共用
 * 兜底表：上面两层都没有（AI 没配 / 还没生成完 / 老数据）时，保证面板不开天窗。
 *
 * 预算（2026-09-21 放宽）：动态候选最多 MAX_DYNAMIC_OPTIONS 个（方案给了几个就上几个），
 * 后面固定跟「用了别的」和「说不清」两格——「说不清」少一个都不行，
 * 不然用户"说不清"的时候会随便勾一个，脏数据比空数据更糟。
 */
function buildOptions(type, reminder, rule) {
  const planOptions = Array.isArray(reminder && reminder.options) ? reminder.options : []
  const careOptions = Array.isArray(reminder && reminder.care_options) ? reminder.care_options : []

  const merged = []
  const push = (label) => {
    const text = String(label || '').trim()
    if (!text || merged.length >= MAX_DYNAMIC_OPTIONS) return
    if (merged.indexOf(text) >= 0) return
    merged.push(text)
  }
  planOptions.forEach(push)
  careOptions.forEach(push)

  if (!merged.length) {
    return { options: rule.options, question: rule.question, source: 'fallback' }
  }

  const list = merged.map((label, index) => ({ value: type + '_' + index, label }))
  list.push({ value: 'other', label: '用了别的（补充里写）' })
  list.push({ value: 'unsure', label: '说不清' })

  return {
    options: list,
    // 方案自己带的问题优先（每次都不一样），没有才用固定的
    question: (reminder && reminder.ask) || rule.question,
    source: 'dynamic'
  }
}

Component({
  properties: {
    show: {
      type: Boolean,
      value: false
    },
    reminder: {
      type: Object,
      value: null
    }
  },

  data: {
    // ask：太早档先问"已经做了 / 只是安排到那天"；form：正常登记；reschedule：选日期
    stage: 'form',
    earlyText: '',
    // 逾期太久的追问（和后端 LATE_REASON_LABEL 的 key 对应）
    showLate: false,
    lateOptions: LATE_OPTIONS,
    lateReason: '',
    lateMap: {},
    lateQuestion: '',
    rescheduleDate: '',
    rescheduleText: '',
    questionText: '',
    options: [],
    multi: true,
    picked: [],
    pickedMap: {},
    occurredAt: '',
    occurredText: '',
    todayText: '',
    minDate: '',
    noteOpen: false,
    note: '',
    safetyText: '',
    // B-2：提交后的回执气泡
    sending: false,
    echoText: '',
    icons: ICONS
  },

  observers: {
    'show, reminder': function (show, reminder) {
      if (!show) return
      this.reset(reminder)
    }
  },

  methods: {
    reset(reminder) {
      const type = (reminder && reminder.type) || 'default'
      const rule = OPTION_TABLE[type] || OPTION_TABLE.default
      const today = new Date()
      const min = new Date(today.getTime() - MAX_DAYS_BACK * 86400000)
      const todayText = dateString(today)
      const built = buildOptions(type, reminder, rule)

      this.setData({
        stage: 'form',
        earlyText: '',
        showLate: false,
        lateReason: '',
        lateMap: {},
        lateQuestion: '',
        questionText: built.question,
        options: built.options,
        multi: rule.multi,
        picked: [],
        pickedMap: {},
        occurredAt: todayText,
        occurredText: '今天',
        todayText,
        minDate: dateString(min),
        noteOpen: false,
        note: '',
        safetyText: SAFETY_TEXT[type] || '',
        sending: false,
        echoText: ''
      })

      // 太早档：先走二选一，选"已经做了"才进入登记
      const timing = (reminder && reminder.timing) || {}
      if (timing.level === 'too_early') {
        const dueDay = localDayOf(reminder.due_at)
        this.setData({
          stage: 'ask',
          earlyText: '这条原本安排在 ' + friendlyDate(dueDay, todayText) +
            '，今天完成会提前 ' + timing.early_days + ' 天。已经做了吗？',
          rescheduleDate: dueDay,
          rescheduleText: friendlyDate(dueDay, todayText)
        })
      }

      // 逾期超过容忍天数：多问一题"这段时间是什么情况"
      if (timing.level === 'too_late') {
        this.setData({
          showLate: true,
          // 措辞按《措辞规范》：陈述事实、给选择、不给压力；
          // 句子收短是为了让 5 个选项不用滚动就能看全
          lateQuestion: '这条提醒已经过去 ' + timing.late_days +
            ' 天了。不方便做也没关系，告诉托蕾妮一声就行。'
        })
      }
    },

    onPickLate(event) {
      const key = event.currentTarget.dataset.key
      const next = this.data.lateReason === key ? '' : key
      const map = {}
      if (next) map[next] = true
      this.setData({ lateReason: next, lateMap: map })
    },

    onPickDone() {
      this.setData({ stage: 'form' })
    },

    onPickReschedule() {
      this.setData({ stage: 'reschedule' })
    },

    onRescheduleDateChange(event) {
      const value = event.detail.value
      this.setData({
        rescheduleDate: value,
        rescheduleText: friendlyDate(value, this.data.todayText)
      })
    },

    onSubmitReschedule() {
      this.triggerEvent('reschedule', { due_at: this.data.rescheduleDate })
    },

    onToggle(event) {
      const value = event.currentTarget.dataset.value
      const multi = this.data.multi
      let picked = this.data.picked.slice()

      if (multi) {
        const index = picked.indexOf(value)
        if (index >= 0) picked.splice(index, 1)
        else picked.push(value)
      } else {
        // 单选：再点一次可以取消，这样"一题不选直接提交"才走得通
        picked = picked[0] === value ? [] : [value]
      }

      const map = {}
      picked.forEach((item) => { map[item] = true })
      this.setData({ picked, pickedMap: map })
    },

    onDateChange(event) {
      const value = event.detail.value
      this.setData({
        occurredAt: value,
        occurredText: friendlyDate(value, this.data.todayText)
      })
    },

    onToggleNote() {
      this.setData({ noteOpen: !this.data.noteOpen })
    },

    onNoteInput(event) {
      this.setData({ note: event.detail.value })
    },

    onCancel() {
      this.triggerEvent('cancel')
    },

    onSubmit() {
      if (this.data.sending) return

      const { picked, options, occurredAt, note, lateReason } = this.data
      const labels = picked
        .filter((value) => value !== 'unsure')
        .map((value) => {
          const found = options.find((item) => item.value === value)
          return found ? found.label : value
        })

      const payload = {
        occurred_at: occurredAt,
        done_items: labels,
        // 没选任何一项 = 跳过，记"未登记"，不能当成"按方案做了"
        unsure: picked.length === 0 || picked.indexOf('unsure') >= 0,
        note: String(note || '').trim(),
        late_reason: lateReason || '',
        late_note: lateReason === 'other' ? String(note || '').trim() : ''
      }

      // 「这段时间不需要做」→ 问一句要不要拉长间隔（这一问在面板之外，
      // 所以不占"恒定 ≤2 个问题块"的预算）
      if (lateReason === 'not_needed') {
        wx.showModal({
          title: '要不要拉长间隔',
          content: '这类提醒的间隔要不要先拉长一点？确认后下一次会隔更久再提醒。',
          confirmText: '拉长',
          cancelText: '保持原样',
          success: (res) => {
            this.submitWithEcho(Object.assign({}, payload, { extend_interval: Boolean(res.confirm) }))
          }
        })
        return
      }

      this.submitWithEcho(payload)
    },

    /**
     * 先把「我」的气泡发出去，再把提交事件交给页面。
     *
     * 页面收到事件才真正写库、关面板，所以气泡能完整看到；
     * 但等待长度是固定的动画时长，**不等 AI**——AI 只是有机会把
     * 气泡里的文字换成更自然的一句，换不上就用本地拼接的那句。
     */
    submitWithEcho(payload) {
      const labels = payload.done_items || []
      const fallback = this.localSentence(labels, payload.unsure)
      const reminderId = this.data.reminder && this.data.reminder.id
      const canAskAI = labels.length > 0 && !payload.unsure && Boolean(reminderId)

      this.setData({ sending: true, echoText: fallback })

      if (canAskAI) {
        this.requestEcho(reminderId, labels)
          .then((text) => {
            // 面板可能已经被关掉了（用户手快点了关闭），那就不要再改数据
            if (text && this.data.sending) this.setData({ echoText: text })
          })
          .catch(() => {})
      }

      setTimeout(() => {
        this.triggerEvent('submit', payload)
      }, ECHO_HOLD_MS)
    },

    /**
     * AI 没回来、没配 key、断网时用的那句。
     * 必须能独立成立——很多情况下用户看到的就是这一句。
     */
    localSentence(labels, unsure) {
      const list = (labels || []).filter(Boolean)
      if (!list.length || unsure) return '这次就不具体登记了'
      return list.join('、')
    },

    /** 请 AI 把勾选项说成一句人话；失败就让调用方用本地那句 */
    requestEcho(reminderId, labels) {
      return request({
        url: '/reminders/' + reminderId + '/echo',
        method: 'POST',
        data: { items: labels },
        timeout: ECHO_TIMEOUT_MS
      }).then((data) => String((data && data.text) || '').trim())
    }
  }
})
