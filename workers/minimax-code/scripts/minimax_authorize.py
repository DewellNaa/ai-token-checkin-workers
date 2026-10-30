#!/usr/bin/env python3
"""MiniMax Code 授权脚本：走 OAuth 2.0 设备码流程（RFC 8628）换取 access/refresh token。

流程：
  1. POST account.minimax.cn/oauth2/device/code  → 拿到 user_code + 浏览器验证链接
  2. 在浏览器打开链接、输入 user_code 并确认授权
  3. 本脚本轮询 account.minimax.cn/oauth2/token    → 拿到 access_token + refresh_token
  4. 将令牌写入 Cloudflare Worker 的 KV 命名空间，并做首次签到验证

用法：
  python minimax_authorize.py --worker https://your-worker.workers.dev --key YOUR_ADMIN_KEY
  # 或通过环境变量配置：
  # export MINIMAX_WORKER_URL=https://your-worker.workers.dev
  # export MINIMAX_ADMIN_KEY=your_admin_key
  # python minimax_authorize.py
"""

import argparse
import base64
import hashlib
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
COMMON_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "..", "common"))
if os.path.exists(COMMON_DIR):
    sys.path.insert(0, COMMON_DIR)

try:
    from proxy_util import pick_proxy, curl as _proxy_curl
except ImportError:
    def pick_proxy(explicit=None):
        return explicit or os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY") or ""
    def _proxy_curl(url, proxy=None):
        cmd = ["curl", "-sS", "--max-time", "60"]
        if proxy:
            cmd += ["-x", proxy]
        cmd.append(url)
        return subprocess.check_output(cmd, text=True)

ACCOUNT_BASE = "https://account.minimax.cn"
DEVICE_CODE_ENDPOINT = ACCOUNT_BASE + "/oauth2/device/code"
TOKEN_ENDPOINT = ACCOUNT_BASE + "/oauth2/token"
OAUTH_FORM = {"client_id": "mcode-public", "scope": "agent.default", "audience": "agent-backend"}
DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
STATE_FILE = os.path.join(HERE, "oauth-state.json")


def http(url, data=None, method=None, headers=None, proxy=None, timeout=40):
    """走代理的 HTTP 请求（优先 curl）。"""
    cmd = ["curl", "-sS", "--max-time", str(timeout)]
    if proxy:
        cmd += ["-x", proxy]
    if method:
        cmd += ["-X", method]
    for k, v in (headers or {}).items():
        cmd += ["-H", f"{k}: {v}"]
    if data is not None:
        cmd += ["--data", data]
    cmd.append(url)
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 20)
    if p.returncode != 0:
        raise RuntimeError(f"curl 退出码 {p.returncode}: {p.stderr.strip()}")
    return p.stdout


def _pkce_verifier():
    raw = secrets.token_bytes(32)
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _pkce_challenge(verifier):
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def request_device_code(proxy):
    verifier = _pkce_verifier()
    challenge = _pkce_challenge(verifier)
    form = {
        **OAUTH_FORM,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    raw = http(DEVICE_CODE_ENDPOINT, data=urllib.parse.urlencode(form), method="POST",
               headers={"Content-Type": "application/x-www-form-urlencoded"},
               proxy=proxy)
    try:
        body = json.loads(raw)
    except ValueError:
        raise RuntimeError(f"非 JSON 响应：{raw[:300]}")
    if not body.get("device_code"):
        raise RuntimeError(f"设备码申请失败：{raw[:300]}")
    body["code_verifier"] = verifier
    return body


def poll_token(state, proxy, wait_seconds=300):
    deadline = time.time() + wait_seconds
    interval = max(int(state.get("interval") or 3), 2)
    while time.time() < deadline:
        form = {
            "grant_type": DEVICE_CODE_GRANT,
            "device_code": state["device_code"],
            "client_id": OAUTH_FORM["client_id"],
            "code_verifier": state["code_verifier"],
        }
        try:
            raw = http(TOKEN_ENDPOINT, data=urllib.parse.urlencode(form), method="POST",
                       headers={"Content-Type": "application/x-www-form-urlencoded"},
                       proxy=proxy)
            try:
                body = json.loads(raw)
            except ValueError:
                body = {}
        except Exception as e:
            print(f"  轮询异常（重试中）：{str(e)[:120]}", flush=True)
            time.sleep(interval)
            continue

        signal = str(body.get("error") or body.get("status") or "").lower()
        if signal in ("authorization_pending", "pending"):
            print("  等待在浏览器中完成授权确认…", flush=True)
            time.sleep(interval)
            continue
        if signal == "slow_down":
            interval += 3
            time.sleep(interval)
            continue
        if signal in ("access_denied", "denied"):
            raise RuntimeError("授权被拒绝")
        if signal == "expired_token":
            raise RuntimeError("设备码已过期，请重新运行脚本")
        if body.get("access_token"):
            return body
        print(f"  未识别响应：{raw[:200]}", flush=True)
        time.sleep(interval)
    raise RuntimeError(f"等待超时（{wait_seconds}s）")


def main():
    ap = argparse.ArgumentParser(description="MiniMax Code OAuth 设备码授权与 Worker 凭证推送")
    ap.add_argument("--poll", action="store_true", help="非交互模式：读取已保存的 state 继续轮询")
    ap.add_argument("--wait", type=int, default=300, help="轮询等待秒数（默认 300）")
    ap.add_argument("--proxy", default=None, help="显式指定代理地址")
    ap.add_argument("--worker", default=os.environ.get("MINIMAX_WORKER_URL", ""),
                    help="Cloudflare Worker 完整 URL（或通过 MINIMAX_WORKER_URL 设置）")
    ap.add_argument("--key", default=os.environ.get("MINIMAX_ADMIN_KEY", ""),
                    help="Worker ADMIN_KEY（或通过 MINIMAX_ADMIN_KEY 设置）")
    ap.add_argument("--key-file", default=os.path.join(HERE, "admin_key.txt"),
                    help="存放 ADMIN_KEY 的文件路径")
    ap.add_argument("--link-only", action="store_true",
                    help="只生成授权链接并保存 state，不阻塞轮询（适合两阶段执行）")
    args = ap.parse_args()

    proxy = pick_proxy(args.proxy)
    if proxy:
        print(f"使用网络代理：{proxy}")
    else:
        print("未检测到本地代理，尝试直接连接")

    if args.link_only:
        state = request_device_code(proxy)
        json.dump(state, open(STATE_FILE, "w", encoding="utf-8"), ensure_ascii=False)
        print()
        print("=" * 68)
        print("  请在浏览器中打开下方链接，登录 MiniMax 账号后确认授权：")
        print()
        print(f"    {state.get('verification_uri_complete') or state.get('verification_uri')}")
        print()
        print(f"  用户授权码：{state.get('user_code')}")
        print(f"  有效期：{state.get('expires_in')} 秒")
        print()
        print("  授权完成后，执行：python minimax_authorize.py --poll")
        print("=" * 68)
        return 0

    if args.poll:
        if not os.path.exists(STATE_FILE):
            print("找不到 state 缓存文件，请先不带 --poll 运行一次", file=sys.stderr)
            return 1
        state = json.load(open(STATE_FILE, encoding="utf-8"))
    else:
        state = request_device_code(proxy)
        json.dump(state, open(STATE_FILE, "w", encoding="utf-8"), ensure_ascii=False)
        print()
        print("=" * 68)
        print("  请在浏览器中打开下方链接，登录 MiniMax 账号并确认授权：")
        print()
        print(f"    {state.get('verification_uri_complete') or state.get('verification_uri')}")
        print()
        print(f"  用户授权码：{state.get('user_code')}")
        print(f"  有效期：{state.get('expires_in')} 秒")
        print("=" * 68)
        print()

    try:
        grant = poll_token(state, proxy, args.wait)
    except Exception as e:
        print(f"授权未完成：{e}", file=sys.stderr)
        return 1

    access = grant["access_token"]
    refresh = grant.get("refresh_token", "")
    expires_in = int(grant.get("expires_in") or 3600)
    print(f"\n✓ 授权成功！ access_token={access[:12]}…  refresh_token={refresh[:12]}…")
    print(f"  access 有效期 {expires_in}s（refresh token 长期有效，Worker 运行时会自动刷新）")

    # 确定 Worker 与 Admin Key
    worker_url = args.worker.rstrip("/")
    admin_key = args.key
    if not admin_key and os.path.exists(args.key_file):
        admin_key = open(args.key_file, encoding="utf-8").read().strip()

    if not worker_url or not admin_key:
        print("\n提示：未提供 Worker URL 或 ADMIN_KEY，跳过写入 Worker。")
        print("如需推送到 Worker，请提供参数：")
        print("  python minimax_authorize.py --worker https://your-worker.workers.dev --key YOUR_KEY")
        return 0

    url = (f"{worker_url}/checkin?key={urllib.parse.quote(admin_key)}"
           f"&token={urllib.parse.quote(access, safe='')}"
           f"&refresh_token={urllib.parse.quote(refresh, safe='')}")
    print("\n正在将令牌写入 Cloudflare Worker 并执行首次签到验证…")
    raw = http(url, proxy=proxy, timeout=90)
    try:
        print(json.dumps(json.loads(raw), ensure_ascii=False, indent=2))
    except ValueError:
        print(raw[:600])

    if os.path.exists(STATE_FILE):
        try:
            os.remove(STATE_FILE)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
