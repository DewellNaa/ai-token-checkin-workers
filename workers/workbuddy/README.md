# WorkBuddy（Buddy加油站）每日签到 Worker

> 基于 Cloudflare Worker 的腾讯 WorkBuddy（CodeBuddy）每日积分自动化领取套件。

---

## 核心机制

- **基础签到 + 派猫旅行全自动化**：每日早晨 08:07（Cron）准时触发，不仅完成基础每日签到，还会自动检查旅行状态，若在途已到达则自动领奖（获取 5~10 额外积分与信件道具），并在空闲时自动挑选收益最高的地点派出新旅行。
- **多渠道消息推送**：支持飞书群机器人 Webhook、Bark (iOS)、PushPlus 微信通知，每次签到与旅行结果实时送达手机。
- **防抢令牌设计**：WorkBuddy 访问令牌（Access Token）有效期长达 30 天，且服务端在刷新令牌时会轮换 Refresh Token。若每天无脑刷新，会与桌面客户端抢占令牌导致客户端被迫下线。本项目 Worker 将访问令牌缓存在 KV 中，仅在距过期不足 1 天时才进行刷新，极大降低掉线风险。
- **完全云端无人值守**：一旦将初始 Refresh Token 推送至 Worker，后续刷新与签到完全在 Cloudflare 云端闭环进行，关机照常签到。

---

## 消息推送配置（可选）

如需每次签到/旅行完成后推送到手机或群聊，设置对应环境变量（或通过 `wrangler secret put`）：
- **飞书群机器人**：设置 `FEISHU_WEBHOOK`（格式：`https://open.feishu.cn/open-apis/bot/v2/hook/xxxx`）
- **Bark (iOS)**：设置 `BARK_KEY` 或 `BARK_URL`
- **微信推送 (PushPlus)**：设置 `PUSHPLUS_TOKEN`

---

## 快速上手

### 1. 部署 Cloudflare Worker
```bash
# 创建 KV
npx wrangler kv namespace create WB
# 复制 id 填入 wrangler.toml
cp wrangler.toml.example wrangler.toml

# 设置管理密钥
npx wrangler secret put ADMIN_KEY

# 部署
npx wrangler deploy
```

### 2. 提取本地凭证并推送到云端
```bash
# 提取并查看本地凭证信息
python scripts/extract_token.py

# 推送到 Worker 并执行首次签到
python scripts/extract_token.py \
  --push \
  --worker https://your-wb-worker.workers.dev \
  --key YOUR_ADMIN_KEY
```
