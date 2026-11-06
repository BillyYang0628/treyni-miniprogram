<#
.SYNOPSIS
    注册「登录时自动启动托蕾妮后端」的计划任务。

.DESCRIPTION
    为什么需要：这台机器 2026-09-17 重启后后端没跟起来，用户打开小程序
    只看到"连不上后端"，白排查一轮。这个任务让后端在每次登录时自己起来。

    任务跑的是一个隐藏窗口的 PowerShell，后端的输出写到
    工具\gen\autostart.log（UTF-8，中文不会乱码）。

    重复执行是安全的：同名任务会被覆盖。

.PARAMETER Remove
    卸载：删掉这个计划任务并停掉它启动的后端进程。

.EXAMPLE
    pwsh -File 运维\install-autostart.ps1          # 安装
    pwsh -File 运维\install-autostart.ps1 -Remove  # 卸载
#>
param(
  [switch]$Remove,
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$TaskName = 'TreyniBackend'
)

$ErrorActionPreference = 'Stop'

if ($Remove) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "已删除计划任务: $TaskName"
  } else {
    Write-Output "没有找到计划任务: $TaskName（可能已经删过了）"
  }
  return
}

$serverDir = Join-Path $ProjectRoot 'server'
if (-not (Test-Path -LiteralPath $serverDir)) { throw "找不到 server 目录: $serverDir" }

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { throw 'PATH 里找不到 node.exe，请先安装 Node.js' }

$logFile = Join-Path $ProjectRoot '工具\gen\autostart.log'
$logDir = Split-Path -Parent $logFile
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

# 先把输出编码设成 UTF-8 再跑 node，否则中文日志在 GBK 控制台下会变成乱码
$inner = @(
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;'
  "Set-Location '$serverDir';"
  "& '$nodeExe' --env-file=.env src/server.js 2>&1 |"
  "Out-File -FilePath '$logFile' -Encoding utf8"
) -join ' '

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command `"$inner`"" -WorkingDirectory $serverDir

# 触发器：用户登录时。
# 2026-09-18 实测：后端 13:11:57 起来了、13:12:45 就被终止
# （计划任务返回 0xC000013A = STATUS_CONTROL_C_EXIT，控制台被关掉），之后一直没人拉起。
# 所以真正管用的是下面的"失败自动重启"——没有它，进程被终止就是静默死亡，
# 用户打开小程序只会看到"连不上后端"。
#
# 不用 -AtStartup：开机触发器要求任务存密码或跑在 SYSTEM 下，
# 前者会弹凭据框（脚本没法自动完成），后者会让服务端以 SYSTEM 身份写项目里的
# 数据库和上传目录，容易出权限问题。登录触发 + 失败重启已经够用。
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description '托蕾妮小程序后端，登录时自动启动（卸载：运维\install-autostart.ps1 -Remove）' `
  -Force | Out-Null

Write-Output "已注册计划任务: $TaskName"
Write-Output "  后端目录: $serverDir"
Write-Output "  node:     $nodeExe"
Write-Output "  日志:     $logFile"
