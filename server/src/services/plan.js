/**
 * 「计划一件事」。
 *
 * 需求（2026-09-18 用户定稿）：
 *   - 计划分**四类以内**和**四类以外**，两者语义完全不同，不能混：
 *       四类内（浇水/施肥/打药/修剪）＋ 换盆  → 会改对应提醒的日期，等于"安排进每日提醒"
 *       四类以外（买补光灯、换位置…）        → 只记一条，不排提醒、不影响周期
 *   - 用户往"其他"里填的内容如果**命中四类的关键词**，要问一句
 *     「这条听起来像一次施肥，要不要顺便安排进每日提醒？」——不能默默当成普通笔记
 *
 * 这里是关键词表唯一的出处，前端不复制一份，避免两边口径漂移。
 */

// 顺序有意义：换盆放最前，"换个盆"不能被别的规则先抢走
const CARE_KEYWORDS = [
  { kind: 'repot', label: '换盆', test: /换盆|换土|移栽|翻盆|上盆|换个?大?盆|换个?土/ },
  { kind: 'fertilizing', label: '施肥', test: /施肥|追肥|上肥|加肥|肥料|花多多|缓释肥|底肥|液肥/ },
  { kind: 'pesticide', label: '打药', test: /打药|喷药|用药|杀虫|杀菌|除虫|驱虫|药液/ },
  { kind: 'pruning', label: '修剪', test: /修剪|剪枝|摘心|打顶|短截|疏枝|剪叶|剪掉/ },
  { kind: 'watering', label: '浇水', test: /浇水|淋水|补水|泡盆|浸盆|浇透/ }
]

const CARE_KINDS = ['watering', 'fertilizing', 'pesticide', 'pruning']

/** 从一段文字里认出这是四类以内的哪一类；认不出来返回 null */
function detectCareKind(text) {
  const value = String(text || '')
  if (!value.trim()) return null

  for (const rule of CARE_KEYWORDS) {
    if (rule.test.test(value)) {
      return { kind: rule.kind, label: rule.label }
    }
  }
  return null
}

/** 这类计划会不会落到每日提醒上 */
function affectsReminders(kind) {
  return CARE_KINDS.includes(kind) || kind === 'repot'
}

module.exports = {
  CARE_KEYWORDS,
  CARE_KINDS,
  detectCareKind,
  affectsReminders
}
