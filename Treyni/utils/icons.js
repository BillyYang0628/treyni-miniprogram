// 像素图标总表
//
// 全部图标都是自己生成的像素风素材，放在 assets/icons/ 下按模块分子目录，
// 命名与用途见 assets/README.md。
// WXML 里要以项目根目录为基准（开头带斜杠），所以这里存的是绝对小程序路径。
//
// 用法：页面里 require 进来，把 key 塞进 data，WXML 用 <image src="{{...}}" />。

const ICONS = {
  // ---- 提醒类型（32~48rpx） ----
  watering: '/assets/icons/reminders/icon-reminder-watering@2x.png',
  fertilizing: '/assets/icons/reminders/icon-reminder-fertilizing@2x.png',
  pesticide: '/assets/icons/reminders/icon-reminder-pesticide@2x.png',
  pruning: '/assets/icons/reminders/icon-reminder-pruning@2x.png',
  treatment: '/assets/icons/reminders/icon-reminder-treatment@2x.png',
  treatmentFeedback: '/assets/icons/reminders/icon-reminder-feedback@2x.png',
  custom: '/assets/icons/reminders/icon-reminder-custom@2x.png',
  bell: '/assets/icons/reminders/icon-reminder-bell@2x.png',

  // ---- AI / 对话 ----
  aiChat: '/assets/icons/ai/icon-ai-chat@2x.png',
  aiChatUser: '/assets/icons/ai/icon-ai-chat-user@2x.png',
  aiDiagnosis: '/assets/icons/ai/icon-ai-diagnosis@2x.png',
  chatWrite: '/assets/icons/ai/icon-ai-chat-write@2x.png',

  // ---- 方案分条 ----
  judge: '/assets/icons/detail/icon-detail-judge@2x.png',
  operate: '/assets/icons/detail/icon-detail-operate@2x.png',
  pitfall: '/assets/icons/detail/icon-detail-pitfall@2x.png',
  season: '/assets/icons/detail/icon-detail-season@2x.png',
  pest: '/assets/icons/detail/icon-detail-pest@2x.png',
  pushpin: '/assets/icons/detail/icon-detail-pushpin@2x.png',

  // ---- 植物档案字段 ----
  pot: '/assets/icons/field/icon-field-pot@2x.png',
  soil: '/assets/icons/field/icon-field-soil@2x.png',
  location: '/assets/icons/field/icon-field-location@2x.png',
  stage: '/assets/icons/field/icon-field-stage@2x.png',
  photo: '/assets/icons/field/icon-field-photo@2x.png',
  guide: '/assets/icons/field/icon-field-guide@2x.png',

  // ---- 天气 ----
  sunny: '/assets/icons/weather/icon-weather-sunny@2x.png',
  cloudy: '/assets/icons/weather/icon-weather-cloudy@2x.png',
  overcast: '/assets/icons/weather/icon-weather-overcast@2x.png',
  rain: '/assets/icons/weather/icon-weather-rain@2x.png',
  heavyRain: '/assets/icons/weather/icon-weather-heavy-rain@2x.png',
  thunder: '/assets/icons/weather/icon-weather-thunder@2x.png',
  snow: '/assets/icons/weather/icon-weather-snow@2x.png',
  fog: '/assets/icons/weather/icon-weather-fog@2x.png',
  wind: '/assets/icons/weather/icon-weather-wind@2x.png',
  weatherUnknown: '/assets/icons/weather/icon-weather-unknown@2x.png',

  // ---- 病害严重程度 ----
  severityHealthy: '/assets/icons/severity/icon-severity-healthy@2x.png',
  severityMild: '/assets/icons/severity/icon-severity-mild@2x.png',
  severityModerate: '/assets/icons/severity/icon-severity-moderate@2x.png',
  severitySevere: '/assets/icons/severity/icon-severity-severe@2x.png',
  severityUnknown: '/assets/icons/severity/icon-severity-unknown@2x.png',

  // ---- 状态 ----
  pending: '/assets/icons/status/icon-status-pending@2x.png',
  done: '/assets/icons/status/icon-done@2x.png',
  failed: '/assets/icons/status/icon-status-failed@2x.png',

  // ---- 操作 ----
  add: '/assets/icons/action/icon-action-add@2x.png',
  edit: '/assets/icons/action/icon-action-edit@2x.png',
  remove: '/assets/icons/action/icon-action-delete@2x.png',
  refresh: '/assets/icons/action/icon-action-refresh@2x.png',

  // ---- 养护报告统计卡 ----
  reportRecords: '/assets/icons/report/icon-report-records@2x.png',

  // ---- 空状态 ----
  emptyReminders: '/assets/icons/empty/empty-reminders@2x.png',
  emptyJournal: '/assets/icons/empty/empty-journal@2x.png',
  emptyReport: '/assets/icons/empty/empty-report@2x.png',
  emptyChat: '/assets/icons/empty/empty-chat@2x.png',
  emptyDiagnosis: '/assets/icons/empty/empty-diagnosis@2x.png',

  // ---- 通用 ----
  leaf: '/assets/icons/common/icon-leaf@2x.png',

  // ---- 插画（不是图标，但和图标一起引用，省得到处写路径） ----
  emptyGarden: '/assets/illustrations/empty-garden.png',
  plantDefault: '/assets/illustrations/plant-default.png',
  plantDetailEmpty: '/assets/illustrations/plant-detail-empty.png',
  // 用 PNG 不用 WebP：WebP 那版是 VP8X（带 alpha 的扩展格式），
  // 开发者工具（Chromium）能显示，但部分真机的解码器不认，真机上会是空白。
  // 见 有待解决的问题.txt 里"真机测试端插画未显示"那条。
  plantFormHeader: '/assets/illustrations/plant-form-header.png',
  // 托蕾妮本人的精灵形象：对话页标题左侧
  elfAvatar: '/assets/illustrations/elf-avatar.png',
  // 用户形象：抱着盆栽的精灵（和 icon-ai-chat-user 是同一个角色的另一种画法）
  profileAvatar: '/assets/illustrations/profile-avatar.png'
}

// 提醒类型（含养护历程里的 diagnosis）→ 图标
const TYPE_ICONS = {
  watering: ICONS.watering,
  fertilizing: ICONS.fertilizing,
  pesticide: ICONS.pesticide,
  pruning: ICONS.pruning,
  repot: ICONS.pot, // 换盆（事件型，用花盆图标）
  treatment: ICONS.treatment,
  treatment_feedback: ICONS.treatmentFeedback,
  diagnosis: ICONS.aiDiagnosis,
  custom: ICONS.custom
}

// 天气现象文本 → 图标。和风天气返回的文本很多，认不出来的走兜底。
const WEATHER_ICONS = [
  [/晴/, ICONS.sunny],
  [/多云/, ICONS.cloudy],
  [/阴/, ICONS.overcast],
  [/雷/, ICONS.thunder],
  [/暴雨|大雨/, ICONS.heavyRain],
  [/雨/, ICONS.rain],
  [/雪|冻雨|冰雹/, ICONS.snow],
  [/雾|霾|沙|尘/, ICONS.fog],
  [/风|台风|飓风/, ICONS.wind]
]

function weatherIcon(text) {
  const value = String(text || '')
  const hit = WEATHER_ICONS.find((item) => item[0].test(value))
  return hit ? hit[1] : ICONS.weatherUnknown
}

// 严重程度文本 → 图标
const SEVERITY_ICONS = [
  [/无|健康|未见|正常/, ICONS.severityHealthy],
  [/轻微|轻度|初期/, ICONS.severityMild],
  [/中等|中度|一般/, ICONS.severityModerate],
  [/严重|重度|极重/, ICONS.severitySevere]
]

function severityIcon(text) {
  const value = String(text || '')
  const hit = SEVERITY_ICONS.find((item) => item[0].test(value))
  return hit ? hit[1] : ICONS.severityUnknown
}

module.exports = {
  ICONS,
  TYPE_ICONS,
  weatherIcon,
  severityIcon
}
