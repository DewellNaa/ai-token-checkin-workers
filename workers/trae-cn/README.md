# Trae CN 每日签到 Worker

> 基于 Cloudflare Worker 的字节跳动 Trae AI IDE（含 TRAE SOLO 版）每日 100 积分自动化领取套件。

---

## 核心机制

- **令牌提取**：Trae 客户端将本地登录凭证加密存储于 `storage.json` 中（采用 AES-128-CBC + SHA-512 校验）。通过 Node.js 内置 crypto 模块解密提取访问令牌与设备 ID。
- **设备校验关键点**：实测 Trae 的 `claim`（领取积分）接口必须在请求头中携带 `x-device-id`，否则服务端返回 `code: 9004`（参数不正确）。本项目已完整覆盖该协议细节。
- **协同架构**：访问令牌有效期约 14 天，电脑客户端会在磁盘上自行换新。通过 Windows 计划任务或 cron 每日错峰推送一次至 Worker，Worker 每日准时执行签到。

---

## 快速上手

### 1. 部署 Cloudflare Worker
```bash
# 创建 KV
npx wrangler kv namespace create TR
# 复制 id 填入 wrangler.toml
cp wrangler.toml.example wrangler.toml

# 设置管理密钥
npx wrangler secret put ADMIN_KEY

# 部署
npx wrangler deploy
```

### 2. 本机同步与验证
```bash
# 解密并查看本地状态
python scripts/extract_trae_token.py

# 推送到 Worker 并执行首次签到验证
python scripts/extract_trae_token.py \
  --push \
  --worker https://your-trae-worker.workers.dev \
  --key YOUR_ADMIN_KEY
```

### 3. 配置 Windows 自动同步计划任务（可选）
在 PowerShell 中执行：
```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-trae-token-task.ps1 `
  -WorkerUrl "https://your-trae-worker.workers.dev" `
  -AdminKey "YOUR_ADMIN_KEY"
```
