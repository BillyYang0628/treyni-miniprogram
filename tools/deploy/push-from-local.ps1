<#
.SYNOPSIS
    从本地把代码推到服务器并重启（服务器拉 GitHub 不稳时的替代更新路径）。

.DESCRIPTION
    2026-09-29 实测：腾讯云这台北京轻量 `git ls-remote` 很快，但 `git pull` 的
    fetch 会挂住（4 分钟不返回）。所以除了 update.sh 的 git 路径，再留一条
    "本地直推"的路：只传代码目录，不碰服务器上的 .env、数据库、账号台账。

.EXAMPLE
    pwsh -File 运维\push-from-local.ps1
    pwsh -File 运维\push-from-local.ps1 -DryRun
#>
param(
  [string]$Target = 'ubuntu@82.157.175.155',
  [string]$Key = 'D:\托蕾妮小程序\工具\gen\treyni_deploy_ed25519',
  [string]$AppDir = '/srv/treyni/app',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
# 本脚本现在放在 <根目录>\运维\ 下，根目录就是上一层。
# 2026-10-12 目录全面归类时这里没跟着改（还是 '..\..'，指到了 D:\），
# 结果每个条目都判成"本地缺失"直接跳过——**静默什么都没推**。
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not (Test-Path (Join-Path $root 'server\src'))) {
  throw "根目录判定失败：$root 下没有 server\src"
}
$sshOpts = @('-i', $Key, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes')

# 只推这些：代码与脚本 + 少量**只读的**数据文件。
# 绝不推 server/.env、server/data/treyni.db、server/data/uploads、server/data/admin-backups、工具/gen
# （数据库、上传件、账号台账都在服务器本地，覆盖会丢数据）
$items = @(
  @{ Local = 'server\src';            Remote = 'server/src' },
  @{ Local = 'server\knowledge';      Remote = 'server/knowledge' },
  @{ Local = 'server\data\knowledge'; Remote = 'server/data/knowledge' },
  # 浇水模型的种植条件参数。2026-10-12 漏了这个文件：线上 /knowledge/planting-options 返回空数组，
  # 添加植物页「摆放环境」是必填却没有可选项，用户直接卡死；浇水提醒也因此报 TypeError。
  @{ Local = 'server\data\planting_options.json'; Remote = 'server/data/planting_options.json' },
  # 症状示例图（只读、带许可/署名）；不是用户上传件
  @{ Local = 'server\data\reference';    Remote = 'server/data/reference' },
  # 本地已按 2026-10-12 的归类改名，服务器上同步成同样的名字（旧的 app/tools/ 会在下次推送后成为空壳，可手工清）
  @{ Local = '工具\admin';            Remote = '工具/admin' },
  # 图片识别库外来源：同步脚本要在服务器执行，把 ICAMA 数据落到本地镜像表
  @{ Local = '工具\知识库构建';       Remote = '工具/知识库构建' },
  @{ Local = '运维';                  Remote = '运维' },
  @{ Local = 'server\package.json';   Remote = 'server/package.json' }
)

# 小程序端也要一起送：config.js 里的正式域名分支在服务器上不用，但保持同版本便于排查
$items += @{ Local = 'Treyni'; Remote = 'Treyni' }

Write-Host "== 目标 $Target，应用目录 $AppDir"
foreach ($item in $items) {
  $local = Join-Path $root $item.Local
  if (-not (Test-Path $local)) { Write-Warning "本地缺失，跳过：$($item.Local)"; continue }
  Write-Host ("  推送 {0} -> {1}" -f $item.Local, $item.Remote)
  if ($DryRun) { continue }

  & ssh @sshOpts $Target "rm -rf /tmp/push && mkdir -p /tmp/push"
  & scp @sshOpts -r $local "$Target`:/tmp/push/"
  $leaf = Split-Path $item.Remote -Leaf
  & ssh @sshOpts $Target @"
set -e
sudo mkdir -p '$AppDir/$(Split-Path $item.Remote -Parent)'
sudo rm -rf '$AppDir/$($item.Remote)'
sudo cp -r '/tmp/push/$leaf' '$AppDir/$($item.Remote)'
sudo chown -R treyni:treyni '$AppDir/$($item.Remote)'
"@
}

if ($DryRun) { Write-Host 'DryRun：到此为止'; return }

Write-Host '== 安装依赖并重启'
& ssh @sshOpts $Target @"
set -e
cd '$AppDir/server'
sudo -u treyni npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || true
sudo systemctl restart treyni-api
sleep 3
systemctl is-active treyni-api
curl -fsS --max-time 8 http://127.0.0.1:3000/health | head -c 80
echo
"@
Write-Host '完成'
