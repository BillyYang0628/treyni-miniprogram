#!/usr/bin/env bash
# 托蕾妮小程序后端 · 服务器初始化（Ubuntu 22.04，可重复执行）
#
#   sudo bash bootstrap.sh
#
# 做的事：装 Node 22 / nginx / certbot / sqlite3，建服务账号与目录，
# 拉代码，装 systemd 单元，配防火墙。跑完还要手动做两件事（脚本会提示）：
#   1) 填 /srv/treyni/app/server/.env
#   2) 把域名解析到本机，再签证书
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/BillyYang0628/treyni-miniprogram.git}"
APP_USER="treyni"
APP_ROOT="/srv/treyni"
APP_DIR="$APP_ROOT/app"

log() { printf '\n\033[1;32m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "请用 root 运行：sudo bash $0" >&2
  exit 1
fi

log "1/7 基础软件"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates nginx sqlite3 ufw certbot python3-certbot-nginx

log "2/7 Node.js 22"
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v
npm -v

log "3/7 服务账号与目录"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  # 不给登录密码，只用 sudo 之外的最小权限跑应用
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
fi
mkdir -p "$APP_ROOT" /var/log/treyni
chown -R "$APP_USER:$APP_USER" "$APP_ROOT" /var/log/treyni

log "4/7 拉代码"
if [[ -d "$APP_DIR/.git" ]]; then
  sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only
else
  sudo -u "$APP_USER" git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR/server"
sudo -u "$APP_USER" npm ci --omit=dev 2>/dev/null || sudo -u "$APP_USER" npm install --omit=dev
mkdir -p data/uploads
chown -R "$APP_USER:$APP_USER" data

log "5/7 systemd 服务"
install -m 644 "$(dirname "$0")/treyni-api.service" /etc/systemd/system/treyni-api.service
systemctl daemon-reload
systemctl enable treyni-api.service

log "6/7 nginx 站点"
if [[ -f /etc/nginx/sites-enabled/default ]]; then
  rm -f /etc/nginx/sites-enabled/default
fi
install -m 644 "$(dirname "$0")/nginx-treyni.conf" /etc/nginx/sites-available/treyni
if [[ ! -L /etc/nginx/sites-enabled/treyni ]]; then
  ln -s /etc/nginx/sites-available/treyni /etc/nginx/sites-enabled/treyni
fi
nginx -t
systemctl reload nginx

log "7/7 防火墙与备份"
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable

install -m 755 "$(dirname "$0")/backup-treyni.sh" /usr/local/bin/backup-treyni.sh
cat > /etc/cron.d/treyni-backup <<'CRON'
# 每天 03:20 备份数据库与上传文件，保留 14 天
20 3 * * * root /usr/local/bin/backup-treyni.sh >> /var/log/treyni/backup.log 2>&1
CRON
chmod 644 /etc/cron.d/treyni-backup

cat <<'DONE'

============================================================
初始化完成。接下来三件事（脚本不代做）：

1) 写生产配置（注意权限 600，不要进仓库）：
     sudo -u treyni cp /srv/treyni/app/server/.env.example /srv/treyni/app/server/.env
     sudo -u treyni nano /srv/treyni/app/server/.env
   必改项：
     PUBLIC_BASE_URL=https://api.你的域名
     AUTH_ALLOW_WECHAT=false
     WECHAT_SUBSCRIBE_MINIPROGRAM_STATE=formal
     以及各个 AI / 天气 key
     chmod 600 /srv/treyni/app/server/.env

2) 把域名 A 记录解析到本机公网 IP，等生效后签证书：
     sudo certbot --nginx -d api.你的域名
   （备案通过前用 IP 访问也行，但小程序的合法域名必须是已备案的 https 域名）

3) 起服务并自检：
     sudo systemctl restart treyni-api
     curl -s http://127.0.0.1:3000/health
============================================================
DONE
