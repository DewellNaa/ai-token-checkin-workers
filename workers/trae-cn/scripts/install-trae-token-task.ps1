<#
  Trae CN 令牌定时续期 —— Windows 计划任务自动化注册脚本

  作用：定期从本机 Trae 客户端的 storage.json 解密出最新登录态，推送到 Cloudflare Worker。
  机制说明：Trae 访问令牌有效期约 14 天，客户端会自行刷新本地存储文件。每天自动同步一次，
  可确保云端 Worker 始终持有有效凭据。

  用法（PowerShell 执行）：
    powershell -ExecutionPolicy Bypass -File install-trae-token-task.ps1 -WorkerUrl "https://your-worker.workers.dev" -AdminKey "YOUR_KEY"
#>

param(
  [string]$TaskNamePrefix = "AI-Checkin-Trae-Sync",
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
  Write-Host "[X] 未检测到 Python，请先安装 Python 3.9+ 并加入系统 PATH" -ForegroundColor Red
  exit 1
}
Write-Host "[OK] 使用 Python：$py"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "[X] 未检测到 Node.js（本地解密需要），请安装 Node.js 18+" -ForegroundColor Red
  exit 1
}
Write-Host "[OK] 使用 Node.js：$($node.Source)"

$extractScript = Join-Path $ScriptDir "extract_trae_token.py"
if (-not (Test-Path $extractScript)) {
  Write-Host "[X] 找不到提取脚本 $extractScript" -ForegroundColor Red
  exit 1
}

$cleanWorker = $WorkerUrl.TrimEnd('/')
$arg = "`"$extractScript`" --push --worker `"$cleanWorker`" --key `"$AdminKey`""
$action = New-ScheduledTaskAction -Execute $py -Argument $arg -WorkingDirectory $ScriptDir

# 错峰运行：每天 08:40 与 20:40 各同步一次
$triggers = @(
  (New-ScheduledTaskTrigger -Daily -At "08:40"),
  (New-ScheduledTaskTrigger -Daily -At "20:40")
)

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

$taskName = "$TaskNamePrefix"
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings -Description "Trae CN AI 令牌每日同步至 Cloudflare Worker" | Out-Null

Write-Host "[SUCCESS] 计划任务 [$taskName] 注册成功！" -ForegroundColor Green
Write-Host "计划触发时间：每日 08:40、20:40（云端 Worker 每日 09:07 自动签到）"
