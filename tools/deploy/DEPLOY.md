# 托蕾妮小程序后端 · 上线部署手册

面向：腾讯云轻量应用服务器 2核2G（Ubuntu 22.04，大陆地域，已备案域名）。
目标是 5 个并发用户，nginx + Node + SQLite 单机跑满绰绰有余。

---

## 0. 前置

| 需要先有 | 说明 |
| --- | --- |
| 服务器 | 大陆地域，实例时长 ≥ 3 个月（备案要求），记录公网 IP 与 root 密码 |
| 域名 | 与服务器同一账号购买，已完成实名认证 |
| ICP 备案 | **关键路径，7–20 天**。腾讯云控制台 → 备案，主体要与域名持有者一致 |
| API key | DeepSeek（必需）、和风天气（可选）、百度识花（可选） |

## 1. 初始化服务器

把 `tools/deploy/` 整个目录传到服务器（或直接在服务器上 `git clone` 本项目后进目录执行），然后：

```bash
sudo bash bootstrap.sh
```

脚本可重复执行，做这些事：装 Node 22 / nginx / certbot / sqlite3；建 `treyni` 服务账号；
拉代码到 `/srv/treyni/app`；装 `treyni-api` systemd 单元；配 nginx 站点；开 22/80/443；
装每日备份 cron。

## 2. 写生产配置

```bash
sudo -u treyni cp /srv/treyni/app/server/.env.example /srv/treyni/app/server/.env
sudo -u treyni nano /srv/treyni/app/server/.env
sudo chmod 600 /srv/treyni/app/server/.env
```

必须改的项：

```ini
PUBLIC_BASE_URL=https://api.你的域名
AUTH_ALLOW_WECHAT=false
WECHAT_SUBSCRIBE_MINIPROGRAM_STATE=formal
AI_API_KEY=...        # 不填 AI 功能不可用
QWEATHER_API_HOST=... # 不填浇水模型退化为固定间隔
```

> `.env` 永不入库。本地开发那份也不要直接拷过来——本地是局域网地址、`developer` 状态。

## 3. HTTPS

域名 A 记录指向服务器公网 IP，解析生效后：

```bash
sudo certbot --nginx -d api.你的域名
```

certbot 会自动续期（`systemctl list-timers | grep certbot` 可确认）。

## 4. 起服务并自检

```bash
sudo systemctl restart treyni-api
curl -s http://127.0.0.1:3000/health          # 本机
curl -s https://api.你的域名/health           # 走域名与证书
sudo journalctl -u treyni-api -n 50 --no-pager
```

## 5. 微信侧配置（备案通过后）

1. 公众平台 → 开发管理 → 服务器域名：填 `https://api.你的域名`（request / uploadFile / downloadFile）。
2. 用户隐私保护指引：如实填写收集项（账号标识、植物照片、所在城市）与用途，**不填无法过审**。
3. 小程序端 `Treyni/utils/config.js` 需要有"正式版走 https 域名"这一档（当前只有局域网候选，**上线前必补**）。
4. 上传体验版 → 真机验收 → 提交审核。

## 6. 发账号

在服务器上（会用生产的数据库）：

```bash
cd /srv/treyni/app
sudo -u treyni node tools/admin/create-account.js new --note="给X老师"
sudo -u treyni node tools/admin/create-account.js list
```

口令只在生成时打印一次，同时追加到 `tools/gen/accounts.tsv`（不入库）。发给使用者后建议提醒他们别转发。

## 7. 日常运维

| 事项 | 命令 |
| --- | --- |
| 更新版本 | `sudo bash tools/deploy/update.sh`（失败会打印回滚命令） |
| 看日志 | `sudo journalctl -u treyni-api -f` 或 `tail -f /var/log/treyni/api.log` |
| 备份 | 每天 03:20 自动；产物在 `/srv/treyni/backup`，保留 14 天 |
| 手动备份 | `sudo /usr/local/bin/backup-treyni.sh` |
| 停用账号 | `node tools/admin/create-account.js disable <账号>` |
| 重置口令 | `node tools/admin/create-account.js reset <账号>` |
| AI 花费 | 看 `/srv/treyni/app/server/data/ai_metrics.jsonl` |

## 8. 回滚

```bash
sudo -u treyni git -C /srv/treyni/app log --oneline -10
sudo -u treyni git -C /srv/treyni/app reset --hard <上一个提交>
sudo systemctl restart treyni-api
curl -s http://127.0.0.1:3000/health
```

## 9. 上线前检查清单

- [ ] `/health` 返回 200（本机与域名各一次）
- [ ] `.env` 权限 600，且 `AUTH_ALLOW_WECHAT=false`
- [ ] 微信后台已填合法域名
- [ ] 隐私保护指引已提交
- [ ] `config.js` 已支持正式域名
- [ ] 备份 cron 跑过一次（`sudo /usr/local/bin/backup-treyni.sh`）
- [ ] 用 5 个账号并发试一轮：花园页、提醒详情（AI 生成）、图片上传
