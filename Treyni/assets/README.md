> **公开仓说明**：本文件是这份图标/插画清单的原始记录，下面附录里的重新生成步骤依赖
> 未随仓库分发的美术母版（`插画素材/`）与本地 Windows 工具链，仅作方法说明。
> 图标清单与用途部分（前半篇）与仓库内容一一对应。
# Treyni 静态资源目录说明

更新日期：2026-09-16

本目录按照《界面图标清单与规格.md》§2.4 与《小程序插画清单与AI提示词.md》§七两份文档的分类建立，
把两者的方案合并为「icons/ 下按模块分子目录 + illustrations/ 独立存放」。

---

## 目录结构

```
Treyni/assets/
├── illustrations/          插画（像素风主视觉），一份即可
└── icons/                  图标，按模块分类
    ├── tabbar/             tabBar 图标，81×81，选中/未选中各一张
    ├── reminders/          提醒类型，浇水/施肥/打药/修剪/处理/反馈/自定义
    ├── detail/             方案分条图标，判断/操作/踩坑/季节/用量/虫害/兜底
    ├── field/              植物档案字段，花盆/土壤/位置/光照/日期/苗情/来源/照片
    ├── weather/            天气，晴/多云/阴/雨/暴雨/雷/雪/雾/风/预警
    ├── severity/           病害严重程度，健康/轻微/中等/严重/待确认
    ├── report/             数据报告，天数/记录/提醒/准时/诊断/处理
    ├── status/             状态与告警，生成中/已完成/失败
    ├── action/             操作按钮，新增/编辑/删除/完成/搜索/定位/刷新/返回
    ├── ai/                 AI 相关，诊断/对话/两侧头像/生成阶段
    ├── common/             跨模块复用，叶子等
    ├── empty/              空状态大图，花园/提醒/日记/报告/对话/诊断
    └── brand/              品牌素材，logo-256 / logo-512 / avatar
```

目录里现在有 **4 个 tabBar + 54 个图标 = 58 个 PNG**，另有 **9 个插画文件**
（7 张插画，其中 `welcome` 和 `plant-form-header` 各多一份 WebP）+ **1 张品牌图**（见下）。

### `brand/` 现在有什么（2026-09-21 接入）

| 文件 | 尺寸 | 体积 | 用在哪 |
| --- | --- | --- | --- |
| `share-cover.png` | 800×640（5:4） | 74KB | 转发卡片封面：花园页 / 植物详情 / 提醒详情三个页面的 `onShareAppMessage` |

- 源图与备选底色在 `插画素材\brand\`，**量化进包用 `python tools/quantize-brand.py`**（可重跑，改底色只改脚本里的 palette）。
  原图 196KB 直接进包会让主包逼近上限（当时打进包 1.75MB / 上限 2MB），量化到 192 色后 74KB，视觉核对无色带。
- **Logo 不在包里**：它的用途是小程序后台头像（mp.weixin.qq.com 手动上传），包内没有引用方
  （「关于托蕾妮」是 `wx.showModal` 纯文字弹窗）。量化版留档在 `插画素材\brand\logo-512.png`；
  后台头像建议传**原图** `logo-512-cream.png`（180KB，不占包体积、质量更好）。
- **默认头像 `avatar.png` 不做**：「我的」页在用 `illustrations/profile-avatar.png`，小程序也没有取微信头像，
  "默认头像"就是"唯一头像"，再做一张是重复文件。

## 页面怎么引用

不要在页面里手写路径，统一从 `Treyni/utils/icons.js` 取：

```js
const { ICONS } = require('../../utils/icons')

Page({
  data: { icons: ICONS }        // WXML 里就能写 src="{{icons.watering}}"
})
```

```html
<image class="icon-sm" src="{{icons.watering}}" mode="aspectFit" />
```

`icons.js` 里还有两个按文本挑图标的函数：`weatherIcon(weather.now.text)` 和
`severityIcon(...)`，和风天气返回的文本很多，认不出来的会走各自的兜底图标。

WXML 里的尺寸档（`icon-xs` 32rpx / `icon-sm` 40rpx / `icon-md` 48rpx / `icon-lg` 64rpx /
`icon-empty` 160rpx）定义在 `app.wxss`。

## 命名规则

| 类别 | 规则 | 示例 |
| --- | --- | --- |
| 图标 | `icon-{模块}-{语义}[-{状态}]@2x.png` | `icon-reminder-watering@2x.png` |
| tabBar | `tab-{页面}[-active].png`（**不加 @2x 后缀**） | `tab-garden-active.png` |
| 空状态 | `empty-{场景}@2x.png` | `empty-garden@2x.png` |
| 品牌 | `{类型}-{尺寸}.png` | `logo-256.png` |
| 插画 | 全小写英文 + 中划线，**不加后缀** | `plant-form-header.png` |

全小写、中划线分隔，**不要出现中文和空格**（中文文件名在微信开发者工具里容易踩坑）。

## 规格速查

| 用途 | 显示尺寸 | @2x | @3x | 单张体积 |
| --- | --- | --- | --- | --- |
| 行内小图标 | 28–32rpx | 32×32 | 48×48 | ≤ 20KB |
| 按钮/次级图标 | 36–40rpx | 40×40 | 60×60 | ≤ 20KB |
| 卡片标题/统计图标 | 40–48rpx | 48×48 | 72×72 | ≤ 20KB |
| 空状态大图 | 120–160rpx | 120×120 | 180×180 | ≤ 40KB |
| tabBar | — | 81×81（单份） | — | **≤ 40KB** |
| 品牌头像 | 64–120rpx | 256×256 | 512×512 | ≤ 40KB |
| 插画（横幅） | 页面顶部横幅 | 1024×512 | — | ≤ 200KB |

配色：主绿 `#1b4d3e` / `#2d6a4f`，次级 `#6b7d6b`，暖色 `#d9a03c`，
警示 `#c0503c`（仅用于病害/失败），背景 `#f0ead6` / `#faf8f0`。

## 引用方式

```html
<!-- WXML 中以项目根目录为基准，开头加斜杠 -->
<image src="/assets/icons/reminders/icon-reminder-watering@2x.png" />
```

**注意：WXSS 的 background-image 不能引用本地路径**，只能用 base64 或网络地址。
需要背景装饰请用 `<image>` 组件。

## 源文件在哪

本目录只存放**处理好的成品**。生成出来的原始大图、母版、试稿都放在
`插画素材\`，需要改尺寸或重新裁剪时从母版出发。

生图环境（通义万相 / wan2.7-image-pro）的配置说明见
`生图环境配置说明.md`。

## 已完成素材

### 插画

| 清单序号 | 文件 | 尺寸 | 体积 | 透明底 | 母版来源 | 用在哪 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `illustrations/elf-avatar.png` | 512×512 | 243KB | ✅ | `插画素材\elf-green-1.png`（角色原图 → 卡通化 → 调色 → 提亮深绿） | **对话页标题「托蕾妮」左侧** |
| 2 | `illustrations/profile-avatar.png` | 256×256 | 80KB | ✅ | `插画素材\profile-avatar-test-2.png` | **「我的」页头像卡（微信用户侧）** |
| 3 | `illustrations/empty-garden.png` | 512×512 | 122KB | ✅ | `插画素材\empty-garden-edit.png`（花盆已改为空盆） | 花园页「还没有添加植物」 |
| 4 | `illustrations/plant-default.png` | 256×256 | 42KB | ✅ | `插画素材\Wan_Agent_现在生成以下要求图片…png` | 花园卡片与档案的默认图 |
| 5 | `illustrations/plant-form-header.png` | 1024×512 | 266KB | ✅ | `插画素材\plant-form-header-v2.png` | ❌ 未引用（见下面的包体积说明） |
| 5 | `illustrations/plant-form-header.webp` | 1024×512 | 21KB | ✅ | 同上 | 添加植物页顶部横幅 |
| 6 | `illustrations/plant-detail-empty.png` | 512×512 | 179KB | ✅ | `插画素材\plant-detail-B.png`（场景版，含合上的带锁日记） | **植物养护历程「还没有记录」** |
| 14 | `illustrations/welcome.png` | 1024×1024 | 1.4MB | ❌ 白底 | `插画素材\welcome.png` | ❌ 未引用（见下面的包体积说明） |
| 14 | `illustrations/welcome.webp` | 1024×1024 | 72KB | ❌ 白底 | 同上 | ❌ 还没有欢迎页 |

> **谁是谁（2026-09-16 定稿）**
>
> - `elf-avatar.png` = **托蕾妮本人**（绿色长发、藤蔓缠绕）。用在她出场的地方：
>   对话页标题左侧。对话气泡里的小头像用的是同一角色的**图标版** `icon-ai-chat@2x.png`
>   （气泡 + 绿发精灵，自带气泡边框）。
> - `profile-avatar.png` = **用户形象**（草帽 + 抱着盆栽的精灵）。用在「我的」页头像卡。
>   对话气泡用户侧用的是同一角色的**图标版** `icon-ai-chat-user@2x.png`。
>
> 两处「插画版 / 图标版」是刻意的：插画有场景和姿态，适合占地大的位置；
> 图标只留头像和气泡，缩到 80rpx 仍然清楚。

> **包体积（2026-09-16 处理）**：主包上限 2MB。上面第 5 条的 PNG（266KB）和第 14 条的
> PNG（1.4MB）都是对应 WebP 的备份，页面里一个都没引用，加起来 1.7MB，
> 会把主包顶到 3.3MB 导致传不上去。
> 已在 `Treyni/project.config.json` 的 `packOptions.ignore` 里把这两个文件排除出打包：
>
> ```json
> { "type": "file", "value": "assets/illustrations/welcome.png" },
> { "type": "file", "value": "assets/illustrations/plant-form-header.png" }
> ```
>
> 文件本身还在原处，不影响随时取用；如果想彻底从 `assets/` 挪走，删掉这两条 ignore 再把
> 文件移到 `插画素材\` 即可。排除后主包约 1.6MB。
>
> 其余插画（`elf-avatar.png` 243KB、`plant-detail-empty.png` 179KB、`profile-avatar.png` 79KB）
> 2026-09-16 都已接到页面上，不再有"只占体积不露面"的素材——只有 `welcome.webp`
> 还在等一个欢迎/登录页。

### 图标（58 张，含 4 个 tabBar）

除 `icons/ai/` 三张和 `icons/empty/` 五张是 **256×256** 外，其余统一 **128×128、透明底**。
「引用于」一列写的是实际渲染到界面上的地方；标「备用」的是做出来了但页面还没用上。

#### tabBar（4 张，81×81，单张 ≈600B）

| 文件 | 图形 | 说明 |
| --- | --- | --- |
| `icons/tabbar/tab-garden.png` / `-active.png` | 方形花盆 + 三片叶子 | 「我的花园」，未选中 #6b7d6b、选中 #1b4d3e |
| `icons/tabbar/tab-profile.png` / `-active.png` | 圆头短发胸像 | 「我的」，同上 |

已在 `app.json` 的 `tabBar.list` 里配好 `iconPath` / `selectedIconPath`。
生成方式见下面的「tabBar 怎么做的」。

#### reminders/ 提醒类型（8 张）

| 文件 | 体积 | 图形 | 引用于 |
| --- | --- | --- | --- |
| `icon-reminder-watering@2x.png` | 12KB | 洒水壶 + 三滴水（清单 7） | 浇水提醒、提醒详情「土壤水分估算」 |
| `icon-reminder-fertilizing@2x.png` | 15KB | 肥料袋（清单 8） | 施肥提醒、方案里「用药/浓度」条目 |
| `icon-reminder-pesticide@2x.png` | 10KB | 小药瓶（清单 9） | 打药提醒、报告「用药处理」 |
| `icon-reminder-pruning@2x.png` | 12KB | 修枝剪（清单 10） | 修剪提醒 |
| `icon-reminder-treatment@2x.png` | 11KB | 药片 + 胶囊 | 喷药处理提醒 |
| `icon-reminder-feedback@2x.png` | 11KB | 打勾的记事卡 | 用药效果反馈；也用在「完整操作方案」标题 |
| `icon-reminder-custom@2x.png` | 16KB | 铅笔 + 便签 | 自定义养护提醒 |
| `icon-reminder-bell@2x.png` | 12KB | 系绿叶的铃铛（清单 16） | 「每日提醒」标题、订阅推送菜单、提醒详情加载态 |

#### detail/ 方案分条（6 张）

对应 `pages/reminder-detail/reminder-detail.js` 的 `ICON_RULES`，按条目的关键词配图。

| 文件 | 体积 | 图形 | 引用于 |
| --- | --- | --- | --- |
| `icon-detail-judge@2x.png` | 10KB | 放大镜（镜片里有一片叶） | 「判断/怎么看」条目、对话「正在翻档案」 |
| `icon-detail-operate@2x.png` | 10KB | 扳手 | 「操作/怎么做」条目 |
| `icon-detail-pitfall@2x.png` | 13KB | 三角警示牌 | 「别踩坑」条目、我的页天气预警 |
| `icon-detail-season@2x.png` | 13KB | 挂环日历 | 「季节/间隔」条目、档案日期、花园卡片日期、报告「养护天数」 |
| `icon-detail-pest@2x.png` | 12KB | 小毛毛虫 | 「防治对象」条目 |
| `icon-detail-pushpin@2x.png` | 10KB | 红色图钉 | 方案条目的兜底图标 |

#### field/ 植物档案字段（6 张）

| 文件 | 体积 | 图形 | 引用于 |
| --- | --- | --- | --- |
| `icon-field-pot@2x.png` | 20KB | 陶土花盆 | 花园页标题、添加植物按钮、档案花盆 |
| `icon-field-soil@2x.png` | 16KB | 三块堆叠的土块 | 档案土壤 |
| `icon-field-location@2x.png` | 10KB | 水滴形定位针 | 档案位置、我的页「养护位置」、花园卡片位置 |
| `icon-field-stage@2x.png` | 14KB | 两片叶的幼苗 | 苗情字段、「我的花园」菜单、加载/空状态 |
| `icon-field-photo@2x.png` | 12KB | 相机 | 添加植物页照片占位 |
| `icon-field-guide@2x.png` | 16KB | 叶子 + 太阳封面的书（清单 17） | 种植条件速查菜单、对话「正在查知识」 |

> 清单里的 `icon-field-light`（光照）和 `icon-field-date`（日期）没有单独出图，
> 直接复用 `weather/icon-weather-sunny` 和 `detail/icon-detail-season`。

#### weather/ 天气（10 张）

`utils/icons.js` 的 `weatherIcon()` 按和风天气返回的文本挑图标，认不出来的走 `-unknown`。

| 文件 | 体积 | 对应天气 | 引用于 |
| --- | --- | --- | --- |
| `icon-weather-sunny@2x.png` | 11KB | 晴（清单 18 母版） | 我的页天气、档案光照 |
| `icon-weather-cloudy@2x.png` | 14KB | 多云 | 我的页天气 |
| `icon-weather-overcast@2x.png` | 14KB | 阴 | 我的页天气 |
| `icon-weather-rain@2x.png` | 10KB | 小雨 / 中雨 | 我的页天气、提醒详情「下过雨已重置」 |
| `icon-weather-heavy-rain@2x.png` | 12KB | 大雨 / 暴雨 | 我的页天气 |
| `icon-weather-thunder@2x.png` | 9KB | 雷阵雨 | 我的页天气 |
| `icon-weather-snow@2x.png` | 9KB | 雪 / 冻雨 / 冰雹 | 我的页天气 |
| `icon-weather-fog@2x.png` | 13KB | 雾 / 霾 / 沙尘 | 我的页天气 |
| `icon-weather-wind@2x.png` | 12KB | 风 / 台风 | 我的页天气 |
| `icon-weather-unknown@2x.png` | 9KB | 兜底 | 天气文本没匹配上时 |

#### severity/ 病害严重程度（6 张）

| 文件 | 体积 | 图形 | 引用于 |
| --- | --- | --- | --- |
| `icon-severity-master@2x.png` | 17KB | 三个褐色斑点的叶片（清单 15 母版） | 备用：派生其余状态的参考图 |
| `icon-severity-healthy@2x.png` | 19KB | 绿叶 + 对勾 | 诊断结果「未见异常」 |
| `icon-severity-mild@2x.png` | 13KB | 一个斑点 | 诊断结果「轻微」 |
| `icon-severity-moderate@2x.png` | 13KB | 三个斑点 | 诊断结果「中等」 |
| `icon-severity-severe@2x.png` | 16KB | 大片枯斑 | 诊断结果「严重」 |
| `icon-severity-unknown@2x.png` | 10KB | 灰叶 + 问号 | 诊断结果「待确认」 |

#### status/ 状态（3 张）

| 文件 | 体积 | 图形 | 引用于 |
| --- | --- | --- | --- |
| `icon-status-pending@2x.png` | 17KB | 沙漏 | 提醒列表「托蕾妮正在安排下一轮…」 |
| `icon-done@2x.png` | 12KB | 打勾圆环（清单 11） | 「已按这盆植物调整」、已完成列表、报告标题、反馈「有效」 |
| `icon-status-failed@2x.png` | 17KB | 感叹号圆环 | 「AI 建议生成失败」、反馈「无效」 |

#### action/ 操作（4 张）

| 文件 | 体积 | 图形 | 引用于 |
| --- | --- | --- | --- |
| `icon-action-add@2x.png` | 13KB | 加号圆钮 | 花园页「添加植物」按钮 |
| `icon-action-refresh@2x.png` | 8KB | 循环箭头 | 各处「重新生成」按钮 |
| `icon-action-edit@2x.png` | 9KB | 铅笔 | 备用 |
| `icon-action-delete@2x.png` | 12KB | 垃圾桶 | 备用 |

> 编辑/删除这两个的按钮很窄（每行 4 个，64rpx 高），加图标会把文字挤掉，所以先留着备用。

#### ai/ AI 与头像（4 张，256×256）

| 文件 | 体积 | 图形 | 引用于 |
| --- | --- | --- | --- |
| `icon-ai-diagnosis@2x.png` | 6KB | 叶片 + 放大镜（清单 12） | 诊断页标题、报告「AI 诊断」、养护历程里的诊断记录 |
| `icon-ai-chat@2x.png` | 7KB | 对话气泡 + 绿长发精灵（清单 13） | **助手侧气泡**：左侧气泡、「正在想…」气泡、报错气泡、对话页加载态 |
| `icon-ai-chat-user@2x.png` | 6KB | 对话气泡 + 尖耳朵绿叶发饰精灵 | **用户侧**：对话页右侧气泡、「我的」页头像 |
| `icon-ai-chat-write@2x.png` | 12KB | 钢笔在纸上写 | 对话生成阶段「正在把建议整理成话…」 |

> **两个头像的分工（2026-09-16 定稿）**
>
> | 角色 | 文件 | 出现在 |
> | --- | --- | --- |
> | 托蕾妮（助手） | `icons/ai/icon-ai-chat@2x.png` | 对话页左侧气泡、「托蕾妮正在想…」气泡、报错气泡、加载态 |
> | 用户 | `icons/ai/icon-ai-chat-user@2x.png` | 对话页右侧气泡、「我的」页头像卡 |
>
> 右边这个文件原来叫 `icon-ai-chat-alt@2x.png`（"alt" 版本，插画清单原文里的旧角色设定）。
> 2026-09-16 改名为 `icon-ai-chat-user@2x.png`，身份也由"托蕾妮的备选稿"改成**用户侧头像**，
> 和 `illustrations/profile-avatar.png`（抱着盆栽的同一位精灵）是同一个用户形象。
> 全项目已无 `icon-ai-chat-alt` 的引用，改名不牵扯其它代码。

> **气泡头像为什么没有方形边框（2026-09-16 调整）**
>
> 这两张图**本身就画了气泡边框和左下角的小尾巴**，再套一层 3rpx 方框 + 底色是重复的。
> 去掉方框后可视尺寸会缩小——两张图的内容只占画布 **70% 宽 / 86% 高**（256 里约 180×220），
> 所以盒子从 72rpx 放大到 **80rpx**（可视气泡约 56×69rpx），
> `.bubble-row` 的 CSS `gap` 同时从 14rpx 收到 8rpx，抵消掉图内左右各约 15rpx 的透明边，
> 让文字气泡的起始位置和改动前基本一致。
>
> 对话页标题左侧那张换成了 `illustrations/elf-avatar.png`——它是抠好的透明 PNG，
> **没有**自带边框，所以那里保留了 3rpx 方框 + `#faf8f0` 底色，盒子从 56rpx 提到 64rpx。

#### report/ 报告统计卡（1 张）

| 文件 | 体积 | 图形 | 引用于 |
| --- | --- | --- | --- |
| `icon-report-records@2x.png` | 12KB | 摊开的笔记本 | 报告统计卡「养护记录」 |

> 其余五个统计卡直接复用：养护天数=日历、完成提醒=铃铛、按期完成=打勾圆环、
> AI 诊断=诊断图标、用药处理=药瓶。

#### empty/ 空状态（5 张，256×256）

| 文件 | 体积 | 图形 | 引用于 |
| --- | --- | --- | --- |
| `empty-reminders@2x.png` | 5KB | 立着的木牌 + 对勾 | 植物详情「暂无每日提醒」 |
| `empty-journal@2x.png` | 31KB | 合上的笔记本 | 植物详情「植物不存在」（「还没有记录」已换成场景插画 `plant-detail-empty.png`） |
| `empty-report@2x.png` | 30KB | 立起的纸 + 折角 | 报告页加载态与「还没有养护报告」 |
| `empty-chat@2x.png` | 27KB | 对话气泡 + 叶子 | 备用（对话页现在总是先显示开场白） |
| `empty-diagnosis@2x.png` | 6KB | 相机 + 叶子 | 诊断页上传占位 |

#### common/ 通用（1 张）

| 文件 | 体积 | 图形 | 引用于 |
| --- | --- | --- | --- |
| `icon-leaf@2x.png` | 9KB | 单片叶子 | 提醒/日记类型认不出来时的兜底、「关于托蕾妮」菜单 |

## 素材处理流程

插画从母版到成品的处理分两步，两步都有现成工具：

**1. 缩放**：母版是 2048×2048，按**整数比**缩到目标尺寸（2048→512 是 1/4，2048→256 是 1/8），
避免非整数比把像素边缘插值糊掉。缩放已包含在下面的抠图脚本里。

**2. 抠图**：用 `tools/cutout-image.ps1`（**必须用 PowerShell 7 / pwsh 运行**）。

```powershell
pwsh -File "tools\cutout-image.ps1" `
  -Source "插画素材\<母版>.png" `
  -Output "Treyni\assets\illustrations\<清单文件名>.png" `
  -Size 512
```

脚本做的事：边界泛洪抠掉纯白背景，**再识别"被围住的近白区块"一并清除**——
这一步是必须的，否则木栅栏两根横条之间的空隙、叶片围出来的缝隙这类
不与图像边界相连的白底会残留下来。

对像素风素材，输出保持硬边（半透明像素为 0），避免在深色背景上出现灰边。

**处理完务必验证**：把成品叠在一个洋红（R255 G0 B255）或品牌绿的背景上看一眼，
残留白底和误抠的破洞会非常明显。

---

## 图标是怎么做的（2026-09-16 新增的 42 张）

图标不能靠 AI 一张张直出到最终尺寸，否则风格、留白、体积都会飘。实际走的是
**「AI 出母版 → 确定性后处理」** 三步，每一步都有脚本：

**1. 生成母版**（`tools/gen/*.json` + baoyu-imagine）

每个图标一条任务，共用同一段风格前缀，保证和已有的 18 张插画同源：

```powershell
bun "D:\ClaudeCode\.agents\skills\baoyu-imagine\scripts\main.ts" `
  --batchfile "tools\gen\icons-wave1.json" --jobs 2
```

母版统一落在 `插画素材\icon-masters\`，1024×1024、纯白底。提示词里必须写明
**「不出现任何文字、字母、数字、水印、标签」**——书页、瓶身、袋面这些位置
最容易长出假字，生成后要逐个核对（这次 42 张用视觉模型过了一遍，全部干净）。

**2. 抠图 + 缩放**（`tools/build-icons.ps1`）

```powershell
pwsh -File "tools\build-icons.ps1"          # 全量
pwsh -File "tools\build-icons.ps1" -Only weather   # 只补天气
```

脚本内置「母版名 → 成品路径 + 尺寸」的对照表，调 `cutout-image.ps1` 完成抠图。
1024→128 是 1/8、1024→256 是 1/4，都是整数比，像素边缘不会被插值糊掉。

**3. 压体积**（`tools/quantize-icons.py`）

```powershell
python "tools\quantize-icons.py"
```

AI 直出的 PNG 是全彩存储，但像素画本来就只有几十种颜色。脚本只对超出预算的
文件转成调色板 PNG（普通图标 ≤20KB、空状态 ≤40KB），实测
`icon-ai-chat@2x.png` 53KB → 7KB，肉眼无差别。

### tabBar 怎么做的

tabBar 要求「同一图形、两种品牌色、81×81、纯色稿」，AI 直出做不到，
所以拆成「AI 出一个单色母版 + 脚本染色」：

```powershell
# 2a. 先生成母版（tools/gen/tabbar.json，只出图形，颜色后面覆盖）
# 2b. 抠图
pwsh -File "tools\cutout-image.ps1" `
  -Source "插画素材\icon-masters\tab-garden.png" `
  -Output "插画素材\icon-masters\tab-garden-cutout.png" -Size 512

# 2c. 染色：同一张母版跑两次，得到未选中/选中两版
pwsh -File "tools\colorize-pixel-icon.ps1" `
  -Source "插画素材\icon-masters\tab-garden-cutout.png" `
  -Output "Treyni\assets\icons\tabbar\tab-garden.png" `
  -Color "#6b7d6b"
```

`colorize-pixel-icon.ps1` 做三件事：裁到内容包围盒 → 缩到 27×27 逻辑像素网格 →
按亮度分档映射成「品牌色 ↔ tabBar 底色 #faf8f0」的混合色，最后用 3×3 整数倍
最近邻放大到 81×81。结果是硬边像素块，颜色是精确的 `#6b7d6b` / `#1b4d3e`。

> 脚本里踩过的坑：PowerShell 变量名**大小写不敏感**，`$grid = New-Object Bitmap($Grid, ...)`
> 会直接把参数 `$Grid` 覆盖成 Bitmap，然后报 `Cannot convert Bitmap to Int32`。
> `cutout-image.ps1` 里 `$size` 覆盖 `$Size` 是同一个坑，两个脚本都留了注释。

### 验证方式

图标这种小素材靠肉眼看截图很容易漏，实际用的是两条更硬的证据：

```powershell
# 1) 渲染层核对：直接问模拟器每个 <image> 用的是哪个文件
node "tools\uitest\art-render-check.js"

# 2) 截图 + 视觉核对：截 9 张关键页面到 tools\uitest\shots-art\
node "tools\uitest\art-check.js"

# 3) 拼「改动前 / 改动后」并排对比图，用于交付演示
pwsh -File "tools\uitest\make-compare.ps1" `
  -Pair 'AI花农对话页|shots\full-07-chat-open.png|shots-art\05a-chat-open.png' `
  -Out 'shots-art\compare-chat.png'
```

> 规矩见项目根目录的 `AGENTS.md`：**每次改动都要截图演示**，
> 并排对比图是标准交付形式。

两个脚本都要求开发者工具已经用自动化端口打开：

```powershell
& "D:\微信小程序开发工具\微信web开发者工具\cli.bat" auto `
  --project "Treyni" --auto-port 9420
```
