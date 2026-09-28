# 托蕾妮小程序后端

当前阶段：阶段 3，后端基础与数据库。

## 启动

```bash
npm install
npm run dev
```

健康检查：

```text
GET http://localhost:3000/health
```

## AI 供应商

默认使用 **DeepSeek（deepseek-flash）**，通过 OpenAI 兼容的 `/chat/completions` 调用；
同时也支持 Moonshot（Kimi），换供应商只需改环境变量，不用改代码：

```text
AI_PROVIDER=deepseek          # 或 moonshot
AI_API_KEY=...                # DeepSeek 用 AI_API_KEY；改回 moonshot 时可留空并复用 MOONSHOT_API_KEY
AI_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-flash
AI_VISION_MODEL=deepseek-flash
AI_THINKING_OVERRIDE=         # 留空=按板块策略；调试可填 disabled/low/high/max
```

### 各板块的思考强度

不同板块对"想多久"的需求不同，代码里用一张策略表控制（`src/services/aiAdapter.js` 的 `THINKING_POLICY`）：

| 板块 | 档位 | 实测耗时 |
| --- | --- | --- |
| 诊断·用药指导 | high | 5.8 秒 |
| 诊断·换药建议 | high | 22.5-32.7 秒 |
| 诊断·视觉复核 | high | 1.4-1.6 秒 |
| 诊断·病害介绍 | high | 6.2-13.4 秒 |
| AI 花农对话 | high | 6.9-13.1 秒 |
| 提醒详情方案 | low | 22.9-32.0 秒 |
| 下一轮提醒安排 | low | 11.0-13.9 秒 |
| 一键养护报告 | high | 9.0-17.9 秒 |
| 会话压缩 | low | 2.1-4.1 秒 |

口径（2026-09-14 确认）：质量优先，**单次生成控制在一分钟内**即可，因此不再使用 disabled，
一律至少 low；涉及用药安全与判断的用 high。实测最慢 28.6 秒，41 次调用没有超 60 秒、没有失败。

思考 token 与正文共用 `max_tokens`，所以每个板块的额度 = 正文额度 + 档位预算（low 6000 / high 9000 / max 12000）；
万一思考把额度吃光，会自动退回非思考模式重试一次，保证用户拿到结果。

### 观测与对照

- 每次 AI 调用的供应商、模型、档位、耗时、token 用量都会追加到 `data/ai_metrics.jsonl`。
- `node tools/ai-parity-check.js all` 会把七个 AI 板块跑一遍做功能对照；
  `node tools/ai-output-inspect.js` 用于人工抽查输出文本。

## 目录

- `src/config.js`：环境变量配置
- `src/db.js`：SQLite 初始化与表结构
- `src/app.js`：Express 应用
- `src/server.js`：服务启动入口
- `src/routes/health.js`：健康检查
- `src/middleware/error.js`：统一错误处理
- `src/services/storage.js`：本地图片存储抽象
- `src/services/aiAdapter.js`：AI 服务适配层占位

## 数据库表

- users
- plants
- plant_journal
- plant_reminders
- chat_sessions
- plant_pending_changes

## 下一步建议

1. 微信登录接口与 Token 鉴权
2. 植物 CRUD 接口
3. 图片上传接口
4. 养护日记与提醒接口
5. AI 诊断与精灵对话接口
