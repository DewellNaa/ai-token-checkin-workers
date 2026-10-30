# 四平台 AI 令牌架构与设计深入分析

本文档详细剖析 WorkBuddy、Trae CN、MiniMax Code 和 Qoder CN 四大国内主流 AI 编程助手的令牌生命周期、加密存储机制与 Serverless 自动化架构设计取舍。

---

## 1. 为什么一个通用脚本无法直接复用于四个平台？

表面上看，签到仅仅是向服务端发送一个 HTTP POST 请求并领取当日积分/Credits。然而在底层协议层面，**四大平台的令牌颁发模式、存储形式与刷新机制存在根本性差异**：

| 平台 | 令牌类型 | 客户端本地加密方式 | 刷新机制与难点 |
| :--- | :--- | :--- | :--- |
| **MiniMax Code** | OAuth 2.0 JWT | 不依赖本地文件，走 OAuth 2.0 设备授权码流程 | Access Token 仅存活 1-4 小时，Refresh Token 每次换新后轮换 |
| **Trae CN** | Cloud-IDE-JWT | 本地 `storage.json` AES-128-CBC + SHA-512 校验 | 客户端自行刷新磁盘文件，Worker 必须带 `x-device-id` |
| **Qoder CN** | 静态 Bearer Token | Windows DPAPI + CNG AES-256-GCM / macOS 钥匙串 | 令牌有效 ~16 天，服务端刷新接口强绑定本地设备指纹可执行文件 |
| **WorkBuddy** | OAuth 2.0 JWT | 本地 `workbuddy-desktop.info` 经 Electron 加密信封 | 服务端单向轮换；每天刷新会踢出桌面端客户端登录态 |

---

## 2. 各平台架构详解与避坑设计

### 2.1 MiniMax Code：RFC 8628 OAuth 2.0 设备授权与云端闭环

* **授权流程**：
  1. 脚本发起 `POST https://account.minimax.cn/oauth2/device/code` 获取 `user_code` 和浏览器授权地址。
  2. 用户在网页端登录并确认授权。
  3. 脚本轮询 `POST https://account.minimax.cn/oauth2/token` 换取 `access_token` 与 `refresh_token` 并写入 Cloudflare KV。
* **Cloudflare Worker 内部自洽轮换**：
  MiniMax 的 Access Token 寿命极短（1-4 小时）。Worker 在每次定时任务触发前，检查 Access Token 余量；若距过期不足 2 分钟，则直接在 Cloudflare Worker 内使用 `refresh_token` 向 MiniMax 换取最新令牌，并将轮换出的新 `refresh_token` 立即写回 KV。
* **避坑要点**：
  - MiniMax 签到接口要求显式携带 `timezone_id=Asia%2FShanghai` 查询参数，否则服务端直接报错 `invalid timezone_id`。

---

### 2.2 Trae CN：本地 AES 逆向解密与设备 ID 强校验

* **加密存储逆向**：
  Trae 将凭据存储在 `storage.json` 的 `iCubeAuthInfo://icube.cloudide` 字段中。格式为：
  `[6字节头: tc\x05\x10\x00\x00][32字节随机盐][AES-128-CBC密文]`。
  密钥派生方式为双内置盐值异或后计算 SHA-512。解密后的前 64 字节为 SHA-512 完整性校验哈希，后部为明文 JSON。
* **重大实测陷阱：`x-device-id` 必填性**：
  - 在 Trae 的查询接口 `/status` 中，不传设备头可以正常返回；
  - 但在领取接口 `/claim` 中，**若请求头缺少 `x-device-id`，服务端将直接拦截并报错 `code: 9004 ("The submitted order parameters are incorrect")`**。
  - 本项目解密脚本会同时从 `storage.json` 的 `iCubeAuthInfo://icube-dc:<id>` 键提取真实的 `deviceId`，并在推送至 Worker 时一并绑定。

---

### 2.3 Qoder CN：零依赖 Windows DPAPI + CNG 解密与 16 天无感容灾

* **本地提取方案**：
  Qoder 在 Windows 上采用 Chrome 风格的 DPAPI 保护机制。首先从 `Local State` 文件中提取由 Windows 用户密码保护的 master key，随后使用 CNG（BCrypt）的 AES-256-GCM 解密 `auth.v1.dat`。
  本项目通过 Python `ctypes` 直接调用系统底层的 `crypt32.dll` 与 `bcrypt.dll`，在 Windows 上做到了**完全零第三方库依赖（无需安装体积庞大的 cryptography / cffi 包）**。
* **云端容灾逻辑**：
  由于 Qoder 服务端的 Token 刷新接口需要调用本地二进制文件获取软硬件综合指纹，无法在 Cloudflare Worker 中无损运行。因此架构设计为：
  - 本机设置每日计划任务，开机时自动解密并同步最新 Token 至 Worker；
  - 若用户外出、关机或电脑休眠，Token 原生拥有约 16 天寿命，Worker 可持续在云端领取半个月而不中断。

---

### 2.4 WorkBuddy：防踢下线的 30 天缓存储备设计

* **核心矛盾：抢占式令牌轮换**：
  WorkBuddy 服务端在处理 Refresh Token 换新时，原 Refresh Token 会立即失效并下发新 Token。如果云端 Worker 每天早晨都调用刷新接口，将导致用户电脑上运行的桌面端客户端在下次网络请求时因 Refresh Token 被服务端废弃而强制弹出“登录已失效，请重新登录”。
* **架构解决**：
  WorkBuddy 的 Access Token 有效期长达 30 天。Worker 在 KV 中持久化 Access Token，并在内存中核算到期时间；**仅在距离过期不足 24 小时时才执行一次刷新**。这样既能保证云端无人值守，又彻底避免了与桌面端抢夺登录态。

---

## 3. 安全防护与脱敏规范

1. **脱敏掩码**：所有对外展示接口（`/status`）及日志中，访问令牌与刷新令牌均强制截断为 `xxxx***xxxx`，禁止明文输出完整凭证。
2. **鉴权守卫**：所有会触发真实领取的 HTTP 请求必须携带部署时配置的高强度 `ADMIN_KEY`。
3. **域名白名单**：Worker 严格限制仅向各平台的官方 API 域名发起网络请求，防御任何潜在的 SSRF 探测。
