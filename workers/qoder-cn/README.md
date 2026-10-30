# Qoder CN 每日领取 Credits Worker

> 基于 Cloudflare Worker 的 Qoder AI 编程助手每日 100 Credits（30 天有效期资源包）自动化领取套件。

---

## 核心机制

- **活动时间窗**：Qoder CN 每日活动刷新时间为**北京时间 10:00**（非自然日 0 点）。Worker 设定于每日 10:05 触发。
- **协议要求**：服务端查询与领取必须包含 `Cosy-ClientType: 10` 请求头，否则会返回空活动列表。
- **本地解密无第三方库依赖**：Windows 下采用系统底层 DPAPI 与 CNG（BCrypt）AES-256-GCM 模块解密 `auth.v1.dat`，无需安装 `cryptography` 等体积庞大的 C 扩展。
- **有效期缓冲**：访问令牌有效期约 16 天，即使出差或关机半个月，云端 Worker 仍可稳定自动领取。

---

## 快速上手

### 1. 部署 Cloudflare Worker
```bash
# 创建 KV
npx wrangler kv namespace create Q
# 复制 id 填入 wrangler.toml
cp wrangler.toml.example wrangler.toml

# 设置管理密钥
npx wrangler secret put ADMIN_KEY

# 部署
npx wrangler deploy
```

### 2. 本机同步与验证
```bash
# 提取并查看本地状态
python scripts/refresh_qoder_token.py

# 推送到 Worker 并执行首次领取
python scripts/refresh_qoder_token.py \
  --push \
  --worker https://your-qoder-worker.workers.dev \
  --key YOUR_ADMIN_KEY
```

### 3. 配置 Windows 自动同步计划任务（可选）
在 PowerShell 中执行：
```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-qoder-token-task.ps1 `
  -WorkerUrl "https://your-qoder-worker.workers.dev" `
  -AdminKey "YOUR_ADMIN_KEY"
```
