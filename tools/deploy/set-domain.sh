#!/usr/bin/env bash
# 域名买好、解析生效后，一条命令完成切换：
#   nginx server_name → 申请证书 → 改 .env 的 PUBLIC_BASE_URL → 重启 → 自检
#
#   sudo bash set-domain.sh api.你的域名
#
# 前提：域名 A 记录已经指向本机公网 IP，且解析已生效（dig +short 你的域名 能看到 IP）。
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="/srv/treyni/app"
ENV_FILE="$APP_DIR/server/.env"

if [[ -z "$DOMAIN" ]]; then
  echo "用法：sudo bash $0 api.你的域名" >&2
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  echo "请用 root 运行：sudo bash $0 $DOMAIN" >&2
  exit 1
fi

echo "== 解析检查 $DOMAIN"
if ! getent hosts "$DOMAIN" >/dev/null; then
  echo "！！$DOMAIN 解析不到地址。先把 A 记录指向本机公网 IP，等解析生效再跑。" >&2
  exit 1
fi

echo "== 1/5 nginx server_name -> $DOMAIN"
sed -i "s/server_name .*;/server_name $DOMAIN;/" /etc/nginx/sites-available/treyni
nginx -t
systemctl reload nginx

echo "== 2/5 申请并安装证书（Let's Encrypt，自动续期）"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
  --register-unsafely-without-email --redirect

echo "== 3/5 更新 .env 的 PUBLIC_BASE_URL"
sudo -u treyni sed -i "s#^PUBLIC_BASE_URL=.*#PUBLIC_BASE_URL=https://$DOMAIN#" "$ENV_FILE"
grep '^PUBLIC_BASE_URL=' "$ENV_FILE"

echo "== 4/5 重启服务"
systemctl restart treyni-api
sleep 3
systemctl is-active treyni-api

echo "== 5/5 自检"
curl -fsS --max-time 10 "https://$DOMAIN/health" | head -c 120
echo
echo "证书续期定时器："
systemctl list-timers 'certbot*' --no-pager | head -3

cat <<DONE

============================================================
服务端切换完成。还剩两处要改（脚本改不到）：

1) 小程序端 Treyni/utils/config.js 的 PROD_ORIGIN 改成：
     https://$DOMAIN
   然后重新编译 / 上传一版。

2) 微信公众平台 → 开发管理 → 服务器域名，填：
     https://$DOMAIN
   （request / uploadFile / downloadFile 都要）

备案通过前不要提交正式版：域名必须已备案才算合规。
============================================================
DONE
