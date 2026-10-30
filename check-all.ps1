<#
  四平台 AI 每日签到 —— Windows PowerShell 一键状态巡检
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
    $handler = New-Object System.Net.Http.HttpClientHandler
    if ($Proxy) {
      $handler.Proxy = New-Object System.Net.WebProxy($Proxy)
      $handler.UseProxy = $true
    }
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(20)
    $resp = $client.GetStringAsync($target).GetAwaiter().GetResult()
    return $resp
  } catch {
    return $null
  }
}

Write-Host "`n=== 四平台 AI 签到状态巡检 ===" -ForegroundColor Cyan
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
    Write-Host ("  {0,-14} {1,-10} {2}" -f $name, "未配置", "（请在 .env 中设置 URL）") -ForegroundColor DarkGray
    continue
  }

  $body = Fetch-Status $url
  if (-not $body) {
    Write-Host ("  {0,-14} {1,-10} {2}" -f $name, "不可达", "（网络超时，请检查代理）") -ForegroundColor Yellow
    continue
  }

  try {
    $json = $body | ConvertFrom-Json
    $lr = $json.lastResult
    $ok = $lr.ok
    $claim = if ($lr.claim) { $lr.claim } else { $lr.status }
    $at = if ($lr.at) { $lr.at.Substring(0, [Math]::Min(19, $lr.at.Length)).Replace("T", " ") } else { "-" }
    
    $extra = ""
    if ($null -ne $lr.streak_days) { $extra += " 连签=$($lr.streak_days)天" }
    if ($null -ne $lr.credits) { $extra += " 积分=$($lr.credits)" }
    if ($null -ne $lr.points) { $extra += " 积分=$($lr.points)" }
    if ($ok -eq $false) { $extra += " 错误=" + ($lr.error ? $lr.error : $lr.msg) }

    $statusColor = if ($ok) { "Green" } else { "Red" }
    $statusText = if ($ok) { "成功" } else { "失败" }

    Write-Host ("  {0,-14} " -f $name) -NoNewline
    Write-Host ("{0,-10} " -f $statusText) -ForegroundColor $statusColor -NoNewline
    Write-Host ("{0} {1} ({2})" -f $claim, $extra, $at)
  } catch {
    Write-Host ("  {0,-14} {1,-10} {2}" -f $name, "解析失败", $_.Exception.Message) -ForegroundColor Red
  }
}
Write-Host ""
