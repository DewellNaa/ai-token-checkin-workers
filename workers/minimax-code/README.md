# MiniMax Code 每日签到 Worker

> 跑在 Cloudflare Worker Serverless 上的 MiniMax Code 每日额度领取程序，支持自动令牌轮换，电脑关机也能每日准时签到。

---

## 核心机制

- **协议标准**：采用 RFC 8628 OAuth 2.0 设备码流程授权（官方规范接口）。
- **完全云端自洽**：MiniMax 访问令牌（Access Token）寿命约 1-4 小时，但刷新令牌（Refresh Token）长期有效。Worker 在访问令牌即将过期前自动换新，无需本机参与，实现真正无人值守。
- **幂等设计**：签到前预先查询 `status`，避免重复请求。

---

## 部署步骤

### 1. 创建 Cloudflare KV 命名空间
```bash
npx wrangler kv namespace create MM
```
将终端输出的 `id` 复制并写入 `wrangler.toml`：
```bash
cp wrangler.toml.example wrangler.toml
# 编辑 wrangler.toml 填入 KV id
```

### 2. 设置管理密钥
```bash
npx wrangler secret put ADMIN_KEY
# 输入一个高强度的随机密钥（例如 32 位随机字符）
```

### 3. 部署 Worker
```bash
npx wrangler deploy
```

### 4. 获取授权并推送到 Worker
运行授权脚本，按照终端提示在浏览器中点击确认授权：
```bash
python scripts/minimax_authorize.py \
  --worker https://your-minimax-worker.workers.dev \
  --key YOUR_ADMIN_KEY
```

---

## 状态监控与手动触发

- **查询状态**：
  ```bash
  curl -s "https://your-minimax-worker.workers.dev/status"
  ```
- **手动触发**：
  ```bash
  curl -s "https://your-minimax-worker.workers.dev/checkin?key=YOUR_ADMIN_KEY"
  ```
