#!/usr/bin/env bash
# 更新已部署的服务：拉代码 → 装依赖 → 重启 → 自检
set -euo pipefail

APP_DIR="/srv/treyni/app"

if [[ $EUID -ne 0 ]]; then
  echo "请用 root 运行：sudo bash $0" >&2
  exit 1
fi

echo "== 更新前记录当前版本（回滚用）"
BEFORE="$(sudo -u treyni git -C "$APP_DIR" rev-parse --short HEAD)"
echo "当前版本：$BEFORE"

echo "== 拉取最新代码"
sudo -u treyni git -C "$APP_DIR" pull --ff-only

echo "== 安装依赖"
cd "$APP_DIR/server"
sudo -u treyni npm ci --omit=dev 2>/dev/null || sudo -u treyni npm install --omit=dev

echo "== 重启服务"
systemctl restart treyni-api
sleep 2
systemctl --no-pager --lines=0 status treyni-api || true

echo "== 自检"
if curl -fsS http://127.0.0.1:3000/health >/dev/null; then
  echo "✓ /health 正常"
  echo "更新完成：$BEFORE -> $(sudo -u treyni git -C "$APP_DIR" rev-parse --short HEAD)"
else
  echo "✗ /health 不通，回滚命令：" >&2
  echo "  sudo -u treyni git -C $APP_DIR reset --hard $BEFORE && sudo systemctl restart treyni-api" >&2
  exit 1
fi
