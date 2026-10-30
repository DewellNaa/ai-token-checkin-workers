#!/usr/bin/env bash
# ==============================================================================
# 四平台 AI 每日签到 —— 一键状态总览
# 
# 支持平台：
#   - WorkBuddy    (腾讯 Buddy加油站)       每日 08:07 (北京时间)
#   - Trae CN      (字节跳动 Trae)          每日 09:07
#   - MiniMax Code (MiniMax 智能编程)       每日 10:05
#   - Qoder CN     (Qoder 编程助手)         每日 10:05
#
# 用法:
#   bash check-all.sh
# ==============================================================================

set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"

# 读取本地 .env 配置
if [ -f "$ROOT/.env" ]; then
  # shellcheck disable=SC1091
  set -a
  source "$ROOT/.env"
  set +a
fi

PROXY="${PROXY:-http://127.0.0.1:7897}"

fetch() {
  if [ -n "$PROXY" ]; then
    curl -sS --max-time 30 -x "$PROXY" "$1" 2>/dev/null
  else
    curl -sS --max-time 30 "$1" 2>/dev/null
  fi
}

row() {
  printf "  %-14s %-10s %s\n" "$1" "$2" "$3"
}

echo "=== 四平台 AI 签到状态巡检 ==="
python -c "import datetime;u=datetime.datetime.now(datetime.timezone.utc);b=u+datetime.timedelta(hours=8);print('  巡检时间：%s UTC / %s 北京时间' % (u.strftime('%Y-%m-%d %H:%M:%S'), b.strftime('%Y-%m-%d %H:%M:%S')))"
echo

targets=(
  "WorkBuddy|${WORKBUDDY_WORKER_URL:-}"
  "Trae CN|${TRAE_WORKER_URL:-}"
  "MiniMax Code|${MINIMAX_WORKER_URL:-}"
  "Qoder CN|${QODER_WORKER_URL:-}"
)

for entry in "${targets[@]}"; do
  name="${entry%%|*}"
  url="${entry##*|}"

  if [ -z "$url" ]; then
    row "$name" "未配置" "（请在 .env 中设置 URL）"
    continue
  fi

  body="$(fetch "${url%/}/status")"
  if [ -z "$body" ]; then
    row "$name" "不可达" "（网络超时，请检查代理 $PROXY）"
    continue
  fi

  line="$(printf '%s' "$body" | python -c "
import sys, json
try:
    d = json.load(sys.stdin)
    lr = d.get('lastResult') or {}
    claim = lr.get('claim') or lr.get('status') or '?'
    ok = lr.get('ok')
    at = (lr.get('at') or '')[:19].replace('T', ' ')
    extra = ''
    if lr.get('streak_days') is not None:
        extra += ' 连签=' + str(lr.get('streak_days')) + '天'
    if lr.get('credits') is not None:
        extra += ' 积分=' + str(lr.get('credits'))
    if lr.get('points') is not None:
        extra += ' 积分=' + str(lr.get('points'))
    if ok is False:
        extra += ' 错误=' + str(lr.get('error') or lr.get('msg') or claim)[:50]
    status_str = '成功' if ok else '失败'
    print(status_str + ' | ' + str(claim) + extra + ' | ' + at)
except Exception as e:
    print('解析错误 | ' + str(e)[:40] + ' | -')
" 2>/dev/null)"
  row "$name" "${line%%|*}" "$(printf '%s' "$line" | cut -d'|' -f2-)"
done
echo
