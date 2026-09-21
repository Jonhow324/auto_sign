# Linux 自动签到

用于在 Linux 上定时执行 WorkBuddy/CodeBuddy 和 Qoder CN 签到。

## 配置

复制 `.env.example` 为 `.env`，填入凭证：

```bash
cp .env.example .env
chmod 600 .env
```

### 获取 Token

#### Qoder CN Token

运行提取脚本（需要在已登录 Qoder 客户端的 Windows 机器上执行）：

```bash
node get-qoder-token.js
```

脚本会从 `%APPDATA%/QoderCN` 的加密存储中提取 token，输出类似：

```
accessToken: dt-FAwmLi2GKpzbswkntjTfDoiA
```

将输出的 token 填入 `.env` 的 `QODER_ACCESS_TOKEN`。

#### WorkBuddy/CodeBuddy Token

运行提取脚本：

```bash
node get-workbuddy-token.js
```

脚本会从 `%APPDATA%/Code`（VS Code 官方 CodeBuddy 扩展的登录态）的加密存储中提取 token，输出类似：

```
accessToken: eyJhbGciOiJSUzI1NiIs...
uid: 2bd876f8-0263-4ca9-99ff-c0d63747f5a4
```

将输出的值填入 `.env`：
- `WORKBUDDY_ACCESS_TOKEN` - JWT token
- `WORKBUDDY_UID` - 用户 ID

**重要**：
- 必须使用 VS Code 官方 CodeBuddy 扩展（tencent-cloud.coding-copilot）的登录态；CodeBuddy CN IDE 的离线 token 会被 workbuddy.cn 网关 401 拒绝
- 签到接口在 `https://www.workbuddy.cn`（`/billing/meter/checkin-status` 与 `/billing/meter/daily-checkin`），不是 codebuddy.cn
- token 约 30~60 天过期，需要定期重新提取

## 手动运行

```bash
node sign.js
```

脚本只使用 Node.js 内置模块，不需要安装 npm 依赖。每个平台最多执行两次，第二次仍失败时退出码为 `1`；两个平台都成功、已签到或当前没有可领取活动时退出码为 `0`。

执行结果会同时打印到终端，并追加保存到同目录的 `sign.log`。日志不会输出完整 Token。

## 凭证安全

`.env` 和 `sign.log` 都包含运行相关信息，不要提交到 Git。凭证失效后，需要重新从已登录的桌面客户端提取并更新 `.env`。
