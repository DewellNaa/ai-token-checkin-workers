# AI Token Checkin Workers

<div align="center">

**国内主流 AI 编程助手每日额度自动签到套件（Cloudflare Worker Serverless 版）**

*电脑关机也能准时签到 · 自动令牌轮换 · 零第三方重量级依赖 · 4平台全覆盖*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Cloudflare%20Workers-orange.svg)](https://workers.cloudflare.com/)
[![Python](https://img.shields.io/badge/Python-3.8%2B-blue.svg)](https://www.python.org/)
[![Node](https://img.shields.io/badge/Node-18%2B-green.svg)](https://nodejs.org/)

[快速开始](#-快速开始) • [平台矩阵](#-支持平台与特性) • [架构解析](docs/ARCHITECTURE.md) • [故障排查](docs/FAQ_TROUBLESHOOTING.md) • [免责声明](#-免责声明-disclaimer)

</div>

---

## ⚠️ 免责声明 (Disclaimer)

> **本项目仅供网络协议交互分析、个人学习研究及学术交流使用。**
> 1. 本项目代码绕过客户端图形界面调用签到接口，使用自动化脚本代签属于平台服务协议中的灰色地带；
> 2. 使用者在部署和运行本项目前，应充分阅读并遵守各 AI 服务提供商的服务条款与用户协议；
> 3. 任何因直接或间接使用本项目代码而导致的积分扣减、账号风控或限制，均由使用者自行承担；
> 4. **严禁将本项目用于任何形式的商业盈利行为或多账号批量恶意刷量**。

---

## 🌟 支持平台与特性

| 平台 | 每日收益 | 定时触发 (北京时间) | 令牌机制 | 运行架构 |
| :--- | :--- | :--- | :--- | :--- |
| **WorkBuddy** (腾讯 Buddy加油站) | 100 积分 + 连签成长值 | **08:07** | 30 天超长 Access Token 缓存 | 完全云端自洽，防桌面端抢占下线 |
| **Trae CN** (字节跳动 Trae IDE) | 100 积分 | **09:07** | 本地 AES-128 解密 + `x-device-id` | 本地轻量同步 + 云端准时签到 |
| **MiniMax Code** (海螺/MiniMax) | 每日积分 (首日赠 1024) | **10:05** | RFC 8628 OAuth 2.0 设备授权 | 自动轮换 Refresh Token，完全云端闭环 |
| **Qoder CN** (Qoder 智能助手) | 100 Credits (30天有效期) | **10:05** | 原生 Windows DPAPI+CNG 解密 (~16天) | 错峰本地续期 + 云端 16 天无感容灾 |

---

## 🏗️ 架构概览

```mermaid
flowchart TD
    subgraph Local["🖥️ 本机环境 (按需同步)"]
        TraeApp["Trae 客户端 (storage.json)"] -->|Node 内置 Crypto 解密| TraeScript["extract_trae_token.py"]
        QoderApp["Qoder 客户端 (auth.v1.dat)"] -->|Windows DPAPI + CNG| QoderScript["refresh_qoder_token.py"]
        WBApp["WorkBuddy 客户端"] -->|Electron Helper| WBScript["extract_token.py"]
        MiniMaxAuth["浏览器 OAuth 设备码授权"] -->|RFC 8628| MMScript["minimax_authorize.py"]
    end

    subgraph Cloudflare["☁️ Cloudflare Workers (关机免开机)"]
        W1["Trae Worker (09:07 Cron)"]
        W2["Qoder Worker (10:05 Cron)"]
        W3["WorkBuddy Worker (08:07 Cron)"]
        W4["MiniMax Worker (10:05 Cron)"]
        KV[("Cloudflare KV 凭据库 (脱敏存储)")]
    end

    subgraph Upstream["🌐 厂商官方 API"]
        TraeAPI["api.trae.cn (带 x-device-id)"]
        QoderAPI["openapi.qoder.com.cn"]
        WBAPI["copilot.tencent.com"]
        MMAPI["agent.minimax.cn"]
    end

    TraeScript -->|推送 Token & DeviceId| W1
    QoderScript -->|每日错峰推送| W2
    WBScript -->|首次写入| W3
    MMScript -->|写入初始 Refresh Token| W4

    W1 <--> KV
    W2 <--> KV
    W3 <--> KV
    W4 <--> KV

    W1 -->|自动领取| TraeAPI
    W2 -->|自动领取| QoderAPI
    W3 -->|自动领取| WBAPI
    W4 -->|自动刷新+领取| MMAPI
```

---

## 🚀 快速开始

### 1. 前置准备
- 一个免费的 [Cloudflare 账号](https://dash.cloudflare.com/)；
- 本地安装 Node.js 18+ 与 Python 3.8+；
- 全局安装 Wrangler CLI：
  ```bash
  npm install -g wrangler
  wrangler login
  ```

### 2. 部署各平台 Worker（以 MiniMax 为例）
```bash
cd workers/minimax-code

# 1. 创建 KV 命名空间
npx wrangler kv namespace create MM
# 将输出的 id 复制填入 wrangler.toml
cp wrangler.toml.example wrangler.toml

# 2. 设置安全管理密钥
npx wrangler secret put ADMIN_KEY

# 3. 部署至边缘节点
npx wrangler deploy

# 4. 浏览器一次性授权并推送到 Worker
python scripts/minimax_authorize.py \
  --worker https://your-minimax-worker.workers.dev \
  --key YOUR_ADMIN_KEY
```

> 其余平台部署步骤完全一致，详见各目录下的独立文档：
> - [MiniMax Code 部署手册](workers/minimax-code/README.md)
> - [Trae CN 部署手册](workers/trae-cn/README.md)
> - [Qoder CN 部署手册](workers/qoder-cn/README.md)
> - [WorkBuddy 部署手册](workers/workbuddy/README.md)

---

## 🔍 一键状态巡检

配置根目录下的 `.env` 文件：
```bash
cp .env.example .env
# 编辑 .env 填入您部署的 4 个 Worker 地址与管理密钥
```

- **Linux / macOS / Git Bash**：
  ```bash
  bash check-all.sh
  ```
- **Windows PowerShell 原生**：
  ```powershell
  .\check-all.ps1
  ```

输出示例：
```text
=== 四平台 AI 签到状态巡检 ===
  巡检时间：2026-10-30 08:30:15 UTC / 2026-10-30 16:30:15 北京时间

  WorkBuddy      成功       already-checked-in 连签=28天 (2026-10-30 00:07:11)
  Trae CN        成功       already-checked-in 积分=100 (2026-10-30 01:07:26)
  MiniMax Code   成功       already-claimed 积分=400 (2026-10-30 02:05:34)
  Qoder CN       成功       claimed 积分=100 (2026-10-30 02:05:11)
```

---

## 📂 项目结构

```text
ai-token-checkin-workers/
├── .github/workflows/ci.yml       # 语法校验与结构自动化测试
├── common/
│   └── proxy_util.py              # Clash/Mihomo 端口智能探测与回退重试
├── docs/
│   ├── ARCHITECTURE.md            # 四平台令牌机制与生命周期深度剖析
│   └── FAQ_TROUBLESHOOTING.md     # 错误代码 (Trae 9004, 1001 等) 速查手册
├── workers/
│   ├── minimax-code/              # MiniMax Code 云端自洽签到 Worker
│   ├── trae-cn/                   # Trae CN 逆向解密与设备验证 Worker
│   ├── qoder-cn/                  # Qoder CN 零依赖解密与 16 天容灾 Worker
│   └── workbuddy/                 # WorkBuddy 30 天抗抢占缓存签到 Worker
├── check-all.sh                   # Linux/macOS 巡检脚本
├── check-all.ps1                  # Windows PowerShell 巡检脚本
├── .env.example                   # 环境变量模板
└── LICENSE                        # 包含免责条款的 MIT 许可证
```

---

## 📜 许可证

本项目基于 [MIT 许可证](LICENSE) 发布。欢迎提交 PR、Issue 或分享交流。
