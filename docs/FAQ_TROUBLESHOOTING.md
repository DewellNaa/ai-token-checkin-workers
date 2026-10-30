# 常见错误代码与故障排查指南 (FAQ & Troubleshooting)

---

## 1. Trae CN 常见问题

### Q1: Trae 签到返回 `claim-failed code=9004 "The submitted order parameters are incorrect"`
* **原因**：Trae 官方领取积分接口强制校验 `x-device-id` 请求头。如果 Worker 的 KV 数据库中 `deviceId` 为空或请求未附加该头部，服务端将拒绝颁发奖励。
* **解决办法**：重新运行 `extract_trae_token.py --push`，最新脚本会自动从本地 `storage.json` 读取设备 ID 并写入 KV。

### Q2: Trae 返回 `code=1001 "无法认证"`
* **原因**：
  1. 本地客户端已长时间未打开，导致存储文件中的访问令牌彻底过期；
  2. 请求头被误加了不兼容的认证头部。
* **解决办法**：在电脑上启动一次 Trae 客户端并确认右上角头像处于登录状态，客户端会自动刷新磁盘文件；随后重新执行同步脚本。

### Q3: Trae 返回 `code=9074 "只能在自家 App 中签到"`
* **原因**：部分特定老版本或特定账号受邀灰度风控策略拦截。
* **解决办法**：检查是否安装了最新版 Trae 客户端，并在同步时带上 `--app "Trae CN"`。

---

## 2. MiniMax Code 常见问题

### Q1: 上游报错 `invalid timezone_id`
* **原因**：MiniMax 签到 API 强制要求在 URL 查询参数中提供标准的 IANA 时区标识。
* **解决办法**：代码已默认附带 `?timezone_id=Asia%2FShanghai`。若二次开发修改了代码，请确保时区参数保留。

### Q2: 授权时脚本报错 `设备码已过期`
* **原因**：RFC 8628 规范中，申请到的设备码一般只有 300 秒（5 分钟）有效时间。如果长时间未在浏览器中点击确认，设备码会失效。
* **解决办法**：重新执行 `python scripts/minimax_authorize.py`，并在终端生成链接后尽快在浏览器中完成授权。

---

## 3. Cloudflare Worker 与网络环境常见问题

### Q1: 修改了 `wrangler.toml` 中的 `crons` 定时时间，为什么到点没有触发？
* **原因**：Cloudflare 边缘节点网络对 Cron Trigger 的路由与调度变更存在 **15 ~ 30 分钟的分发传播延迟**。
* **解决办法**：测试时，请将 Cron 时间设置在“当前时刻 + 35 分钟”之后，或直接通过 HTTP 接口 `/checkin?key=YOUR_ADMIN_KEY` 进行即时触发验证。

### Q2: 国内终端运行脚本访问 `*.workers.dev` 报 `CONNECT tunnel failed, 502` 或超时
* **原因**：
  1. 部分 IDE（如 VSCode/Trae 内置终端）可能会自动注入指向内部开发端口的 `HTTPS_PROXY`，该代理无法访问外网；
  2. 部分运营商对 `*.workers.dev` 域名存在 SNI 阻断。
* **解决办法**：
  - 本项目内置的 `common/proxy_util.py` 会自动扫描本机的 Clash / Mihomo / Sing-box 常用端口（7897 / 7890 / 1080 / 10809）；
  - 您也可以在 Cloudflare 仪表板中为 Worker 绑定自己的独立域名（Custom Domain），完全绕开 `workers.dev` 阻断。

### Q3: Windows 运行 `.ps1` 脚本提示 `在此系统上禁止运行脚本`
* **解决办法**：
  在执行时附加绕过参数：
  ```powershell
  powershell -ExecutionPolicy Bypass -File <脚本名>.ps1
  ```
