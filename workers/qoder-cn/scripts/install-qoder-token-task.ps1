<#
  Qoder CN 令牌定时续期 —— Windows 计划任务自动化注册脚本

  作用：每天定时从本机 Qoder 客户端登录态解密出最新 token，推送到 Cloudflare Worker。
  机制说明：Qoder token 有效期约 16 天，服务端没有无需设备指纹的刷新接口。
  每天自动续期一次，即使电脑关机，Worker 也可借助旧 token 连续工作半个月。

  用法（PowerShell 执行）：
    powershell -ExecutionPolicy Bypass -File install-qoder-token-task.ps1 -WorkerUrl "https://your-worker.workers.dev" -AdminKey "YOUR_KEY"
#>

param(
  [string]$TaskName = "AI-Checkin-Qoder-Sync",
  [Parameter(Mandatory=$true)][string]$WorkerUrl,
  [Parameter(Mandatory=$true)][string]$AdminKey,
  [string]$PythonExe = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Find-Python {
  param([string]$Preferred)
  if ($Preferred -and (Test-Path $Preferred)) { return $Preferred }
  $cands = @()
  foreach ($n in @("python", "python3", "py")) {
    $c = Get-Command $n -ErrorAction SilentlyContinue
    if ($c) { $cands += $c.Source }
  }
  $cands += @(
    "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
    "$env:LOCALAPPDATA\Microsoft\WindowsApps\python.exe"
  )
  foreach ($c in $cands) {
    if ($c -and (Test-Path $c)) {
      try { & $c -c "import sys" 2>$null; if ($LASTEXITCODE -eq 0) { return $c } } catch {}
    }
  }
  return $null
}

$py = Find-Python -Preferred $PythonExe
if (-not $py) {
  Write-Host "[X] 未检测到 Python，请先安装 Python 3.8+ 并加入系统 PATH" -ForegroundColor Red
  exit 1
}
Write-Host "[OK] 使用 Python：$py"

$script = Join-Path $ScriptDir "refresh_qoder_token.py"
if (-not (Test-Path $script)) {
  Write-Host "[X] 找不到提取脚本 $script" -ForegroundColor Red
  exit 1
}

$cleanWorker = $WorkerUrl.TrimEnd('/')
$arg = "`"$script`" --push --worker `"$cleanWorker`" --key `"$AdminKey`""
$action = New-ScheduledTaskAction -Execute $py -Argument $arg -WorkingDirectory $ScriptDir

# 错峰运行：09:50 与 23:50 各同步一次（Worker 于 10:05 自动领取）
$triggers = @(
  (New-ScheduledTaskTrigger -Daily -At "09:50"),
  (New-ScheduledTaskTrigger -Daily -At "23:50")
)

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Description "Qoder CN AI 令牌每日同步至 Cloudflare Worker" | Out-Null

Write-Host "[SUCCESS] 计划任务 [$TaskName] 注册成功！" -ForegroundColor Green
Write-Host "计划触发时间：每日 09:50、23:50（云端 Worker 每日 10:05 自动领取当日 100 Credits）"
