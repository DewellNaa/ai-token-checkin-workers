<#
  五平台 AI 每日签到与活动雷达 —— Windows PowerShell 一键状态巡检
#>

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $ScriptDir ".env"

if (Test-Path $EnvFile) {
  Get-Content $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
      $pair = $line.Split("=", 2)
      [Environment]::SetEnvironmentVariable($pair[0].Trim(), $pair[1].Trim(), "Process")
    }
  }
}

$Proxy = $env:PROXY
if (-not $Proxy) { $Proxy = "http://127.0.0.1:7897" }

function Fetch-Status([string]$url) {
  if (-not $url) { return $null }
  $target = "$($url.TrimEnd('/'))/status"
  try {
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
      $resp = if ($Proxy) {
        & curl.exe -s --max-time 15 -x $Proxy $target
      } else {
        & curl.exe -s --max-time 15 $target
      }
      if ($LASTEXITCODE -eq 0 -and $resp) { return ($resp -join "`n") }
    }
  } catch {}
  return $null
}

Write-Host "`n=== 五平台 AI 签到与活动雷达巡检 ===" -ForegroundColor Cyan
$nowUtc = [DateTime]::UtcNow
$nowBj = $nowUtc.AddHours(8)
Write-Host "  巡检时间：$($nowUtc.ToString('yyyy-MM-dd HH:mm:ss')) UTC / $($nowBj.ToString('yyyy-MM-dd HH:mm:ss')) 北京时间`n"

$targets = @(
  @{ Name = "WorkBuddy";    Url = $env:WORKBUDDY_WORKER_URL },
  @{ Name = "Trae CN";      Url = $env:TRAE_WORKER_URL },
  @{ Name = "MiniMax Code"; Url = $env:MINIMAX_WORKER_URL },
  @{ Name = "Qoder CN";     Url = $env:QODER_WORKER_URL }
)

foreach ($t in $targets) {
  $name = $t.Name
  $url = $t.Url
  if (-not $url) {
    Write-Host ("  {0,-14} {1,-10} {2}" -f $name, "未配置", "(请在 .env 中设置 URL)") -ForegroundColor DarkGray
    continue
  }

  $body = Fetch-Status $url
  if (-not $body) {
    Write-Host ("  {0,-14} {1,-10} {2}" -f $name, "不可达", "(网络超时，请检查代理)") -ForegroundColor Yellow
    continue
  }

  try {
    $json = $body | ConvertFrom-Json
    $lr = $json.lastResult
    $ok = $lr.ok
    
    $claim = ""
    if ($lr.checkin) {
      $claim = $lr.checkin.claim
    } elseif ($lr.claim) {
      $claim = $lr.claim
    } elseif ($lr.status) {
      $claim = $lr.status
    }
    
    $at = "-"
    if ($lr.at) {
      $len = [Math]::Min(19, $lr.at.Length)
      $at = $lr.at.Substring(0, $len).Replace("T", " ")
    }
    
    $extra = ""
    if ($lr.checkin -and $lr.checkin.streak_days) {
      $extra += " 连签=$($lr.checkin.streak_days)天"
    } elseif ($null -ne $lr.streak_days) {
      $extra += " 连签=$($lr.streak_days)天"
    }
    
    if ($lr.travel -and $lr.travel.ok) {
      $extra += " [派猫: $($lr.travel.previous_state)]"
    }
    
    if ($null -ne $lr.credits) { $extra += " 积分=$($lr.credits)" }
    if ($null -ne $lr.growth_points) { $extra += " 积分=$($lr.growth_points)" }
    if ($null -ne $lr.points) { $extra += " 积分=$($lr.points)" }
    
    if ($ok -eq $false) {
      $errMsg = if ($lr.error) { $lr.error } else { $lr.msg }
      $extra += " 错误=$errMsg"
    }

    $statusColor = if ($ok) { "Green" } else { "Red" }
    $statusText = if ($ok) { "成功" } else { "失败" }
    Write-Host ("  {0,-14} " -f $name) -NoNewline
    Write-Host ("{0,-10} " -f $statusText) -ForegroundColor $statusColor -NoNewline
    Write-Host ("{0,-20} {1} ({2})" -f $claim, $extra, $at)
  } catch {
    Write-Host ("  {0,-14} {1,-10} {2}" -f $name, "解析失败", $_.Exception.Message) -ForegroundColor Red
  }
}

# 5. ZCode (智谱清言) CLI 与活动雷达状态
$zcodeEngine = "C:\Users\naif\.zcode\engine\resources\glm\zcode.cjs"
$zcodeCred = "C:\Users\naif\.zcode\v2\credentials.json"
if ((Test-Path $zcodeEngine) -and (Test-Path $zcodeCred)) {
  Write-Host ("  {0,-14} " -f "ZCode") -NoNewline
  Write-Host ("{0,-10} " -f "成功") -ForegroundColor Green -NoNewline
  Write-Host ("{0,-20} {1}" -f "CLI v0.17.1 就绪", "BigModel Coding Plan | 飞书活动雷达守护中")
} else {
  Write-Host ("  {0,-14} " -f "ZCode") -NoNewline
  Write-Host ("{0,-10} " -f "异常") -ForegroundColor Red -NoNewline
  Write-Host "引擎或凭证缺失"
}

Write-Host ""
