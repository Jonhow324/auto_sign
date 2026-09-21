# Linux 自动签到

用于在 Linux 上定时执行 WorkBuddy/CodeBuddy 和 Qoder CN 签到。

## 配置

复制 `.env.example` 为 `.env`，填入从 Windows 客户端提取的凭证：

```bash
cp .env.example .env
chmod 600 .env
```

需要填写：

- `WORKBUDDY_ACCESS_TOKEN`
- `WORKBUDDY_UID`
- `QODER_ACCESS_TOKEN`

## 手动运行

```bash
node sign.js
```

脚本只使用 Node.js 内置模块，不需要安装 npm 依赖。每个平台最多执行两次，第二次仍失败时退出码为 `1`；两个平台都成功、已签到或当前没有可领取活动时退出码为 `0`。

执行结果会同时打印到终端，并追加保存到同目录的 `sign.log`。日志不会输出完整 Token。

## 凭证安全

`.env` 和 `sign.log` 都包含运行相关信息，不要提交到 Git。凭证失效后，需要重新从已登录的桌面客户端提取并更新 `.env`。
