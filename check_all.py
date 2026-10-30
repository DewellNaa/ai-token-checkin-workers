#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""四平台 AI 每日签到一键状态巡检 (Python 跨平台版)"""

import os
import sys
import json
import urllib.request
from datetime import datetime, timezone, timedelta

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except:
    pass

env_file = os.path.join(os.path.dirname(__file__), '.env')
env_vars = {}
if os.path.exists(env_file):
    with open(env_file, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env_vars[k.strip()] = v.strip()

proxy = env_vars.get('PROXY') or os.environ.get('HTTP_PROXY') or 'http://127.0.0.1:7897'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({'http': proxy, 'https': proxy}))

targets = [
    ('WorkBuddy', env_vars.get('WORKBUDDY_WORKER_URL')),
    ('Trae CN', env_vars.get('TRAE_WORKER_URL')),
    ('MiniMax Code', env_vars.get('MINIMAX_WORKER_URL')),
    ('Qoder CN', env_vars.get('QODER_WORKER_URL')),
]

now_utc = datetime.now(timezone.utc)
now_bj = now_utc + timedelta(hours=8)

print("\n=== 四平台 AI 签到状态巡检 ===")
print(f"  巡检时间：{now_utc.strftime('%Y-%m-%d %H:%M:%S')} UTC / {now_bj.strftime('%Y-%m-%d %H:%M:%S')} 北京时间\n")

for name, url in targets:
    if not url:
        print(f"  {name:<14} [未配置] (请在 .env 中设置 URL)")
        continue
    
    status_url = url.rstrip('/') + '/status'
    try:
        req = urllib.request.Request(status_url, headers={'User-Agent': 'Antigravity-Inspector'})
        with opener.open(req, timeout=15) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            lr = data.get('lastResult') or {}
            ok = lr.get('ok')
            
            # 状态文案
            claim = ''
            if 'checkin' in lr and isinstance(lr['checkin'], dict):
                claim = lr['checkin'].get('claim', '')
            elif 'claim' in lr:
                claim = lr.get('claim', '')
            elif 'status' in lr:
                claim = lr.get('status', '')
                
            at = lr.get('at', '-')[:19].replace('T', ' ')
            
            extra = []
            if 'checkin' in lr and lr['checkin'].get('streak_days'):
                extra.append(f"连签={lr['checkin']['streak_days']}天")
            elif lr.get('streak_days'):
                extra.append(f"连签={lr['streak_days']}天")
                
            if 'travel' in lr and lr['travel'].get('ok'):
                extra.append(f"[派猫: {lr['travel'].get('previous_state')}]")
                
            if lr.get('credits') is not None:
                extra.append(f"积分={lr['credits']}")
            if lr.get('growth_points') is not None:
                extra.append(f"积分={lr['growth_points']}")
                
            if ok is False:
                err = lr.get('error') or lr.get('msg') or '失败'
                extra.append(f"错误={err}")
                
            status_tag = "成功" if ok else "待命/失败"
            extra_str = " ".join(extra)
            print(f"  {name:<14} {status_tag:<8} {claim:<20} {extra_str} ({at})")
    except Exception as e:
        print(f"  {name:<14} 不可达   (网络超时或异常: {e})")

print()
