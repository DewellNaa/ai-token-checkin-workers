"""代理自动探测：智能识别并轮询可用的本地代理端口。

为什么需要它：某些开发/沙箱环境（IDE 内置终端、CI/CD 容器）可能注入不可用的内部代理端口，
导致访问 workers.dev / api.cloudflare.com 返回 CONNECT tunnel failed 502。
本工具自动探测 Clash / Mihomo / Sing-box / v2ray 常见代理端口并带回退重试机制。
"""

import os
import socket

CANDIDATE_PORTS = (7897, 7890, 1080, 10809, 7891, 1081)


def port_alive(host, port, timeout=1.5):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def proxy_candidates(explicit=None, candidates=CANDIDATE_PORTS):
    """按优先级列出所有候选代理地址。"""
    out = []
    if explicit:
        out.append(explicit)
    for port in candidates:
        p = f"http://127.0.0.1:{port}"
        if port_alive("127.0.0.1", port) and p not in out:
            out.append(p)
    env = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY")
    if env and env not in out:
        out.append(env)
    if not out:
        out.append("http://127.0.0.1:7897")
    return out


def pick_proxy(explicit=None, candidates=CANDIDATE_PORTS):
    """返回首个监听中的本地代理。"""
    if explicit:
        return explicit
    return proxy_candidates(candidates=candidates)[0]


def curl(url, proxy=None, timeout=90, extra_args=(), retries=2):
    """使用 curl 发起 HTTP 请求，自动进行多代理轮退重试。"""
    import shutil
    import subprocess

    if not shutil.which("curl"):
        raise RuntimeError("需要系统中已安装 curl 命令行工具")

    candidates = proxy_candidates(explicit=proxy)
    last_err = ""

    # 清除全局环境变量，避免二次嵌套代理
    env = {k: v for k, v in os.environ.items()
           if k.upper() not in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY")}

    for attempt in range(max(1, retries)):
        for px in candidates:
            cmd = ["curl", "-sS", "--max-time", str(timeout)]
            if px:
                cmd += ["-x", px]
            cmd += list(extra_args)
            cmd.append(url)
            try:
                p = subprocess.run(cmd, env=env, capture_output=True, text=True,
                                   timeout=timeout + 30, errors="replace")
            except subprocess.TimeoutExpired:
                last_err = "timeout"
                continue
            if p.returncode == 0:
                return p.stdout
            last_err = f"rc={p.returncode}: {(p.stderr or '').strip()[:160]}"
        if attempt + 1 < max(1, retries):
            import time
            time.sleep(2)

    raise RuntimeError(f"curl 全部代理均请求失败（最后错误 {last_err}）")
