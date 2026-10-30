#!/usr/bin/env python3
"""Trae CN 令牌提取与推送脚本：从本地 storage.json 解密登录态并推送到 Cloudflare Worker。

用法：
  python extract_trae_token.py                                      # 仅解密并打印脱敏信息
  python extract_trae_token.py --push --worker <URL> --key <KEY>    # 解密并推送到 Worker
  # 或使用环境变量：
  # export TRAE_WORKER_URL=https://your-worker.workers.dev
  # export TRAE_ADMIN_KEY=your_key
  # python extract_trae_token.py --push
"""

import argparse
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
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

AUTH_KEY = "iCubeAuthInfo://icube.cloudide"
DC_PREFIX = "iCubeAuthInfo://icube-dc:"
APP_NAMES = ["TRAE SOLO CN", "Trae CN", "TRAE SOLO", "Trae"]
DECRYPT_JS = os.path.join(HERE, "decrypt-token.js")


def decrypt_with_node():
    node = shutil.which("node")
    if not node:
        raise RuntimeError("未找到 Node.js 可执行文件，请先安装 Node.js 18+")
    p = subprocess.run([node, DECRYPT_JS], capture_output=True, text=True,
                       timeout=60, errors="replace")
    if p.returncode != 0:
        raise RuntimeError("解密失败：" + (p.stderr or "").strip()[:300])
    out = {}
    for line in p.stdout.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            out[k.strip()] = v.strip()
    if not out.get("DECRYPT_RESULT"):
        raise RuntimeError("解密输出中未检测到有效 token")
    return out


def storage_candidates():
    home = os.path.expanduser("~")
    ap = os.environ.get("APPDATA") or ""
    xdg = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
    if sys.platform == "darwin":
        roots = [os.path.join(home, "Library", "Application Support", a) for a in APP_NAMES]
    elif sys.platform == "win32":
        roots = [os.path.join(ap, a) for a in APP_NAMES]
    else:
        roots = [os.path.join(xdg, a) for a in APP_NAMES]
    out = []
    for name, root in zip(APP_NAMES, roots):
        out.append({
            "root": root,
            "app": name,
            "storage": os.path.join(root, "User", "globalStorage", "storage.json"),
        })
    return out


def extract_device_id(storage):
    for k in storage:
        if k.startswith(DC_PREFIX):
            return k[len(DC_PREFIX):]
    if storage.get("telemetry.devDeviceId"):
        return storage["telemetry.devDeviceId"]
    mid = storage.get("telemetry.machineId")
    if mid:
        return hashlib.sha256(mid.encode()).hexdigest()[:32]
    return ""


def load_trae_auth():
    out = decrypt_with_node()
    storage = {}
    for cand in storage_candidates():
        if not os.path.exists(cand["storage"]):
            continue
        try:
            storage = json.load(open(cand["storage"], encoding="utf-8"))
            break
        except Exception:
            continue
    return {
        "token": out.get("DECRYPT_RESULT", ""),
        "refreshToken": out.get("REFRESH_RESULT", ""),
        "expiredAt": out.get("EXPIRED_AT") or None,
        "refreshExpiredAt": out.get("REFRESH_EXPIRED_AT") or None,
        "userId": out.get("USER_ID", ""),
        "deviceId": out.get("DEVICE_ID", "") or extract_device_id(storage),
        "app": out.get("APP", ""),
    }


def main():
    ap = argparse.ArgumentParser(description="Trae CN 凭据解密与同步")
    ap.add_argument("--push", action="store_true", help="推送到 Worker 并触发一次签到验证")
    ap.add_argument("--worker", default=os.environ.get("TRAE_WORKER_URL", ""),
                    help="Cloudflare Worker 完整 URL（或通过 TRAE_WORKER_URL 配置）")
    ap.add_argument("--key", default=os.environ.get("TRAE_ADMIN_KEY", ""),
                    help="Worker ADMIN_KEY（或通过 TRAE_ADMIN_KEY 配置）")
    ap.add_argument("--key-file", default=os.path.join(HERE, "admin_key.txt"),
                    help="存放 ADMIN_KEY 的文件路径")
    ap.add_argument("--proxy", default=None, help="显式指定代理地址")
    args = ap.parse_args()

    auth = load_trae_auth()
    print(f"匹配客户端：{auth['app']}")
    print(f"访问令牌：{auth['token'][:24]}…  (长度: {len(auth['token'])})")
    print(f"令牌有效期至：{auth['expiredAt']}  (refresh token 到期：{auth['refreshExpiredAt']})")
    if auth.get("deviceId"):
        print(f"提取设备 ID：{auth['deviceId']}")

    if not args.push:
        print("\n（提示：使用 --push 参数可将凭证同步至云端 Worker）")
        return 0

    worker_url = args.worker.rstrip("/")
    admin_key = args.key
    if not admin_key and os.path.exists(args.key_file):
        admin_key = open(args.key_file, encoding="utf-8").read().strip()

    if not worker_url or not admin_key:
        print("\n错误：推送需要提供 --worker 和 --key 参数（或设置环境变量 TRAE_WORKER_URL 与 TRAE_ADMIN_KEY）", file=sys.stderr)
        return 1

    q = {
        "key": admin_key,
        "token": auth["token"],
        "refresh_token": auth["refreshToken"],
    }
    # claim 接口必须带 x-device-id，否则服务端返回 9004
    if auth.get("deviceId"):
        q["device_id"] = auth["deviceId"]
    if auth["expiredAt"]:
        q["expired_at"] = auth["expiredAt"]
    if auth["refreshExpiredAt"]:
        q["refresh_expired_at"] = auth["refreshExpiredAt"]

    url = f"{worker_url}/checkin?" + urllib.parse.urlencode(q)
    print("\n正在向 Worker 同步凭证并执行签到…")
    proxy = pick_proxy(args.proxy)
    raw = proxy_curl(url, proxy=proxy)
    try:
        print(json.dumps(json.loads(raw), ensure_ascii=False, indent=2))
    except ValueError:
        print(raw[:600])
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"执行异常：{e}", file=sys.stderr)
        sys.exit(1)
