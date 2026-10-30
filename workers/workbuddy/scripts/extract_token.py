#!/usr/bin/env python3
"""从本机 WorkBuddy / CodeBuddy 客户端的登录态中提取 refresh_token 并可推送到 Cloudflare Worker。

原理：客户端把登录凭据写入本地 `workbuddy-desktop.info`，令牌字段经 symmetric envelope 加密；
客户端运行时（Electron）内置解密模块。本脚本调用客户端可执行文件与 auth_helper.js 解密。

用法:
    python extract_token.py                                      # 打印脱敏摘要
    python extract_token.py --raw                                # 打印明文 refresh_token
    python extract_token.py --push --worker <URL> --key <KEY>    # 解密并推送到 Worker
    # 或使用环境变量：
    # export WORKBUDDY_WORKER_URL=https://your-worker.workers.dev
    # export WORKBUDDY_ADMIN_KEY=your_key
    # python extract_token.py --push
"""

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
COMMON_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "..", "common"))
if os.path.exists(COMMON_DIR):
    sys.path.insert(0, COMMON_DIR)

try:
    from proxy_util import pick_proxy, curl as proxy_curl
except ImportError:
    def pick_proxy(explicit=None):
        return explicit or os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY") or ""
    def proxy_curl(url, proxy=None):
        cmd = ["curl", "-sS", "--max-time", "60"]
        if proxy:
            cmd += ["-x", proxy]
        cmd.append(url)
        return subprocess.check_output(cmd, text=True)

HELPER_JS_PATH = os.path.join(HERE, "auth_helper.js")

AUTH_BASENAME = os.path.join(
    "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info")
CLI_AUTH_BASENAME = os.path.join(
    "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-cli.info")

AUTH_INPUT_LIMIT = 65536
AUTH_OUTPUT_LIMIT = 65536
AUTH_HELPER_TIMEOUT = 10.0


class AuthError(Exception):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def find_auth_file(explicit=None):
    if explicit:
        p = os.path.abspath(os.path.expanduser(explicit))
        return (p if os.path.exists(p) else None), [p]

    env = os.environ.get("WORKBUDDY_AUTH_FILE")
    if env:
        p = os.path.abspath(os.path.expanduser(env))
        return (p if os.path.exists(p) else None), [p]

    looked_in = []
    candidates = []

    if sys.platform == "win32":
        for base_env in ("APPDATA", "LOCALAPPDATA"):
            val = os.environ.get(base_env)
            if val:
                candidates.append(os.path.join(val, AUTH_BASENAME))
                candidates.append(os.path.join(val, CLI_AUTH_BASENAME))
        home = os.path.expanduser("~")
        candidates.append(os.path.join(home, "AppData", "Roaming", AUTH_BASENAME))
        candidates.append(os.path.join(home, "AppData", "Local", AUTH_BASENAME))
    elif sys.platform == "darwin":
        home = os.path.expanduser("~")
        candidates.append(os.path.join(
            home, "Library", "Application Support", AUTH_BASENAME))
        candidates.append(os.path.join(
            home, "Library", "Application Support", CLI_AUTH_BASENAME))
    else:
        home = os.path.expanduser("~")
        xdg = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
        candidates.append(os.path.join(xdg, AUTH_BASENAME))

    for c in candidates:
        looked_in.append(c)
        if os.path.isfile(c):
            return c, looked_in
    return None, looked_in


def find_workbuddy_runtime(explicit=None):
    if explicit:
        p = os.path.abspath(os.path.expanduser(explicit))
        if os.path.isfile(p):
            return p
        return None

    env = os.environ.get("WORKBUDDY_EXE")
    if env:
        p = os.path.abspath(os.path.expanduser(env))
        if os.path.isfile(p):
            return p
        return None

    candidates = []
    if sys.platform == "win32":
        candidates.extend([
            r"D:\workbuddy\WorkBuddy.exe",
            r"C:\workbuddy\WorkBuddy.exe",
        ])
        for env_key in ("LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"):
            val = os.environ.get(env_key)
            if val:
                candidates.extend([
                    os.path.join(val, "Programs", "WorkBuddy", "WorkBuddy.exe"),
                    os.path.join(val, "WorkBuddy", "WorkBuddy.exe"),
                    os.path.join(val, "Tencent", "WorkBuddy", "WorkBuddy.exe"),
                ])
    elif sys.platform == "darwin":
        candidates.extend([
            "/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy",
            os.path.expanduser("~/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy"),
        ])
    else:
        candidates.extend([
            "/opt/WorkBuddy/workbuddy",
            "/usr/local/bin/workbuddy",
        ])

    for c in candidates:
        if os.path.isfile(c):
            return c
    return None


def _token_format(value):
    if not isinstance(value, dict):
        return "plaintext"
    if value.get("$wbEncrypted") == 1:
        return "envelope"
    return "unknown_dict"


def run_auth_helper(exe_path, request):
    if not os.path.isfile(HELPER_JS_PATH):
        raise AuthError("HELPER_NOT_FOUND")

    cmd = [exe_path, HELPER_JS_PATH]
    env = dict(os.environ)
    env["ELECTRON_RUN_AS_NODE"] = "1"

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )

    data = json.dumps(request).encode("utf-8")
    raw, err = proc.communicate(input=data, timeout=AUTH_HELPER_TIMEOUT)
    if proc.returncode != 0:
        raise AuthError(f"HELPER_EXIT_{proc.returncode}")

    try:
        reply = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError):
        raise AuthError("HELPER_PROTOCOL")
    return reply


def decrypt_value(value, exe):
    reply = run_auth_helper(exe, {"version": 1, "operation": "decrypt", "value": value})
    if not reply.get("ok"):
        raise AuthError(reply.get("reason") or "HELPER_PROTOCOL")
    return reply["accessToken"]


def extract(field="refreshToken", auth_file=None, exe_path=None):
    path, looked_in = find_auth_file(auth_file)
    if not path:
        raise AuthError("NO_AUTH_FILE:" + " | ".join(looked_in))

    with open(path, "r", encoding="utf-8") as fh:
        session = json.load(fh)

    auth = session.get("auth") or {}
    value = auth.get(field)
    if value is None:
        for alias in ("refreshToken", "accessToken"):
            if alias in auth:
                value = auth.get(alias)
                break
    if value is None:
        raise AuthError("NO_FIELD:" + field)

    kind = _token_format(value)
    if kind != "plaintext":
        exe = find_workbuddy_runtime(exe_path)
        if not exe:
            raise AuthError("RUNTIME_NOT_FOUND")
        value = decrypt_value(value, exe)

    info = {
        "field": field,
        "source_file": path,
        "format": kind,
        "length": len(value),
        "preview": f"{value[:10]}...{value[-6:]}",
        "uid": (session.get("account") or {}).get("uid"),
        "domain": auth.get("domain"),
        "refresh_expires_at": auth.get("refreshExpiresAt"),
        "access_expires_at": auth.get("expiresAt"),
    }
    return value, info


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError):
        pass
    ap = argparse.ArgumentParser(description="提取 WorkBuddy 登录态并在需要时推送到 Worker")
    ap.add_argument("--raw", action="store_true", help="打印明文令牌")
    ap.add_argument("--push", action="store_true", help="推送到 Worker 并执行一次签到验证")
    ap.add_argument("--worker", default=os.environ.get("WORKBUDDY_WORKER_URL", ""),
                    help="Cloudflare Worker 完整 URL（或通过 WORKBUDDY_WORKER_URL 配置）")
    ap.add_argument("--key", default=os.environ.get("WORKBUDDY_ADMIN_KEY", ""),
                    help="Worker ADMIN_KEY（或通过 WORKBUDDY_ADMIN_KEY 配置）")
    ap.add_argument("--key-file", default=os.path.join(HERE, "admin_key.txt"),
                    help="存放 ADMIN_KEY 的文件路径")
    ap.add_argument("--field", default="refreshToken", choices=["refreshToken", "accessToken"])
    ap.add_argument("--auth-file", help="手动指定登录态文件路径")
    ap.add_argument("--exe", help="手动指定 WorkBuddy 可执行文件路径")
    ap.add_argument("--proxy", default=None, help="显式指定代理地址")
    args = ap.parse_args()

    try:
        value, info = extract(args.field, args.auth_file, args.exe)
    except AuthError as e:
        print(f"提取失败: {e.reason}", file=sys.stderr)
        return 2

    if args.raw:
        print(value)
        return 0

    print(json.dumps(info, ensure_ascii=False, indent=2))

    if not args.push:
        print("\n（提示：使用 --push 参数可将凭证同步至云端 Worker）")
        return 0

    worker_url = args.worker.rstrip("/")
    admin_key = args.key
    if not admin_key and os.path.exists(args.key_file):
        admin_key = open(args.key_file, encoding="utf-8").read().strip()

    if not worker_url or not admin_key:
        print("\n错误：推送需要提供 --worker 和 --key 参数（或设置环境变量 WORKBUDDY_WORKER_URL 与 WORKBUDDY_ADMIN_KEY）", file=sys.stderr)
        return 1

    url = f"{worker_url}/checkin?key={urllib.parse.quote(admin_key)}&token={urllib.parse.quote(value, safe='')}"
    print("\n正在向 Worker 同步凭证并执行签到…")
    proxy = pick_proxy(args.proxy)
    raw = proxy_curl(url, proxy=proxy)
    try:
        print(json.dumps(json.loads(raw), ensure_ascii=False, indent=2))
    except ValueError:
        print(raw[:600])
    return 0


if __name__ == "__main__":
    sys.exit(main())
