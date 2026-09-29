#!/usr/bin/env bash
# 每日备份：SQLite 热备份（.backup，不是直接拷文件）+ 上传目录，保留 14 天
set -euo pipefail

DATA_DIR="/srv/treyni/app/server/data"
BACKUP_DIR="/srv/treyni/backup"
STAMP="$(date +%Y%m%d-%H%M)"
KEEP_DAYS=14

mkdir -p "$BACKUP_DIR" "$BACKUP_DIR/tmp"
WORK="$BACKUP_DIR/tmp/$STAMP"
mkdir -p "$WORK"

# WAL 模式下直接 cp 数据库可能拿到不一致的快照，必须走 sqlite 自己的 .backup
if [[ -f "$DATA_DIR/treyni.db" ]]; then
  sqlite3 "$DATA_DIR/treyni.db" ".backup '$WORK/treyni.db'"
fi

if [[ -d "$DATA_DIR/uploads" ]]; then
  cp -a "$DATA_DIR/uploads" "$WORK/uploads"
fi

tar -czf "$BACKUP_DIR/treyni-$STAMP.tgz" -C "$WORK" .
rm -rf "$WORK"

# 只清理自己生成的备份文件
find "$BACKUP_DIR" -maxdepth 1 -name 'treyni-*.tgz' -type f -mtime "+$KEEP_DAYS" -delete

echo "$(date '+%F %T') 备份完成 treyni-$STAMP.tgz（保留 $KEEP_DAYS 天）"
