#!/usr/bin/env python3
"""Qoder CN 凭据提取与 Worker 同步脚本。

支持 Windows（基于系统原生 DPAPI + CNG AES-GCM 解密，零第三方依赖）与 macOS。
从本机 Qoder 登录态读取 token 并推送到 Cloudflare Worker。

用法：
  python refresh_qoder_token.py                                      # 仅提取并打印脱敏信息
  python refresh_qoder_token.py --push --worker <URL> --key <KEY>    # 提取并推送到云端 Worker
  # 或使用环境变量：
  # export QODER_WORKER_URL=https://your-worker.workers.dev
  # export QODER_ADMIN_KEY=your_key
  # python refresh_qoder_token.py --push
"""

import argparse
import base64
import glob
import json
import os
from pathlib import Path
import subprocess
import sys
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

IS_WINDOWS = sys.platform == "win32"
AUTH_DIR_GLOB = "com.qodercn.app*"
AUTH_FILE = "auth.v1.dat"
LOCAL_STATE_FILE = "Local State"

if IS_WINDOWS:
    import ctypes
    import ctypes.wintypes as wt

    class _DataBlob(ctypes.Structure):
        _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    class _AeadInfo(ctypes.Structure):
        _fields_ = [
            ("cbSize", wt.ULONG), ("dwInfoVersion", wt.ULONG),
            ("pbNonce", ctypes.POINTER(ctypes.c_ubyte)), ("cbNonce", wt.ULONG),
            ("pbAuthData", ctypes.POINTER(ctypes.c_ubyte)), ("cbAuthData", wt.ULONG),
            ("pbTag", ctypes.POINTER(ctypes.c_ubyte)), ("cbTag", wt.ULONG),
            ("pbMacContext", ctypes.POINTER(ctypes.c_ubyte)), ("cbMacContext", wt.ULONG),
            ("cbAAD", wt.ULONG), ("cbData", ctypes.c_ulonglong), ("dwFlags", wt.ULONG),
        ]

    def _dpapi_unprotect(data):
        src = _DataBlob(len(data), ctypes.create_string_buffer(data, len(data)))
        dst = _DataBlob()
        if not ctypes.windll.crypt32.CryptUnprotectData(
            ctypes.byref(src), None, None, None, None, 0x01, ctypes.byref(dst)
        ):
            raise RuntimeError(f"DPAPI 解密失败: {ctypes.WinError()}")
        try:
            return ctypes.string_at(dst.pbData, dst.cbData)
        finally:
            ctypes.windll.kernel32.LocalFree(dst.pbData)

    def _decrypt_gcm_cng(key, nonce, blob):
        bcrypt = ctypes.WinDLL("bcrypt.dll")
        ct, tag = blob[:-16], blob[-16:]

        def chk(res, what):
            if res != 0:
                raise RuntimeError(f"CNG {what} 失败 NTSTATUS=0x{res & 0xFFFFFFFF:08x}")

        h_alg = ctypes.c_void_p()
        h_key = ctypes.c_void_p()
        try:
            chk(bcrypt.BCryptOpenAlgorithmProvider(ctypes.byref(h_alg), "AES", None, 0), "OpenAlg")
            mode = "ChainingModeGCM"
            chk(bcrypt.BCryptSetProperty(h_alg, "ChainingMode", mode, (len(mode) + 1) * 2, 0), "SetProperty")
            kbuf = ctypes.create_string_buffer(key, len(key))
            chk(bcrypt.BCryptGenerateSymmetricKey(h_alg, ctypes.byref(h_key), None, 0, kbuf, len(key), 0), "GenKey")
            nbuf = (ctypes.c_ubyte * len(nonce)).from_buffer_copy(nonce)
            tbuf = (ctypes.c_ubyte * len(tag)).from_buffer_copy(tag)
            info = _AeadInfo()
            info.cbSize = ctypes.sizeof(_AeadInfo)
            info.dwInfoVersion = 1
            info.pbNonce = ctypes.cast(nbuf, ctypes.POINTER(ctypes.c_ubyte))
            info.cbNonce = len(nonce)
            info.pbTag = ctypes.cast(tbuf, ctypes.POINTER(ctypes.c_ubyte))
            info.cbTag = len(tag)
            ibuf = ctypes.create_string_buffer(ct, len(ct))
            obuf = ctypes.create_string_buffer(len(ct))
            done = ctypes.c_ulong()
            chk(bcrypt.BCryptDecrypt(h_key, ibuf, len(ct), ctypes.byref(info), None, 0, obuf, len(ct), ctypes.byref(done), 0), "Decrypt")
            return obuf.raw[:done.value]
        finally:
            if h_key:
                bcrypt.BCryptDestroyKey(h_key)
            if h_alg:
                bcrypt.BCryptCloseAlgorithmProvider(h_alg, 0)


def find_auth_dirs():
    override = os.environ.get("QODER_AUTH_DIR")
    if override:
        return [Path(override).expanduser()]
    if IS_WINDOWS:
        appdata = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
        try:
            roots = sorted(glob.glob(str(appdata / AUTH_DIR_GLOB)), key=os.path.getmtime, reverse=True)
        except OSError:
            roots = []
        return [Path(r) for r in roots]
    return []


def load_session():
    if not IS_WINDOWS:
        raise NotImplementedError("目前零依赖脚本主要支持 Windows。macOS 请使用 QODER_TOKEN 环境变量")
    dirs = find_auth_dirs()
    if not dirs:
        raise RuntimeError(f"未找到 Qoder 客户端数据目录（%APPDATA%\\{AUTH_DIR_GLOB}），请先安装并登录 Qoder")

    for root in dirs:
        auth_p = root / AUTH_FILE
        state_p = root / LOCAL_STATE_FILE
        if not auth_p.is_file() or not state_p.is_file():
            continue
        try:
            raw = auth_p.read_bytes()
            if raw[:3] != b"v10":
                continue
            state = json.loads(state_p.read_text(encoding="utf-8"))
            crypt = state.get("os_crypt") or {}
            key_blob = base64.b64decode(crypt.get("encrypted_key") or "")
            if key_blob[:5] != b"DPAPI":
                continue
            key = _dpapi_unprotect(key_blob[5:])
            plain = _decrypt_gcm_cng(key, raw[3:15], raw[15:])
            sess = json.loads(plain.decode("utf-8"))
            if sess.get("token"):
                return sess
        except Exception as e:
            continue

    raise RuntimeError("未能从本地存储解密有效 Qoder 登录态，请确认客户端已保持登录")


def main():
    ap = argparse.ArgumentParser(description="Qoder CN 凭据解密与同步")
    ap.add_argument("--push", action="store_true", help="推送到 Worker 并执行一次签到验证")
    ap.add_argument("--worker", default=os.environ.get("QODER_WORKER_URL", ""),
                    help="Cloudflare Worker 完整 URL（或通过 QODER_WORKER_URL 配置）")
    ap.add_argument("--key", default=os.environ.get("QODER_ADMIN_KEY", ""),
                    help="Worker ADMIN_KEY（或通过 QODER_ADMIN_KEY 配置）")
    ap.add_argument("--key-file", default=os.path.join(HERE, "admin_key.txt"),
                    help="存放 ADMIN_KEY 的文件路径")
    ap.add_argument("--proxy", default=None, help="显式指定代理地址")
    args = ap.parse_args()

    sess = load_session()
    token = sess.get("token", "").strip()
    expires_at = sess.get("expiresAt", "")
    print(f"提取 Qoder 访问令牌：{token[:6]}***{token[-4:]} (长度: {len(token)})")
    if expires_at:
        print(f"令牌有效期至：{expires_at}")

    if not args.push:
        print("\n（提示：使用 --push 参数可将凭据同步至云端 Worker）")
        return 0

    worker_url = args.worker.rstrip("/")
    admin_key = args.key
    if not admin_key and os.path.exists(args.key_file):
        admin_key = open(args.key_file, encoding="utf-8").read().strip()

    if not worker_url or not admin_key:
        print("\n错误：推送需要提供 --worker 和 --key 参数（或设置环境变量 QODER_WORKER_URL 与 QODER_ADMIN_KEY）", file=sys.stderr)
        return 1

    url = f"{worker_url}/claim?key={urllib.parse.quote(admin_key)}&token={urllib.parse.quote(token, safe='')}"
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
        print(f"错误：{e}", file=sys.stderr)
        sys.exit(1)
