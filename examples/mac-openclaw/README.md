# Mac 端参考客户端（OpenClaw + Protocol v3.2 Worker）

> 本目录属于 `examples/` 展示实例，与核心协议（`protocol/`）、云端中枢（`server/`）和 SDK（`sdk/`、`sdk-python/`、`mcp/`）完全隔离。

Mac 端以 **OpenClaw** 作为本地 Agent 执行引擎，通过 macOS 后台守护服务（LaunchAgent）常驻运行，实现：
- **云端共享记忆**：每轮对话前自动调用 `POST /edge/v1/memory/assemble` 注入跨设备共享记忆、已学习的设备边界和近期动态；对话结束后异步上报 `POST /edge/v1/memory/ingest`。
- **Protocol v3.2 并发 WebSocket Worker（`maxConcurrency=2`）**：通过 `/edge/v1/ws` 保持 `ws_online` 长连接、单调游标续传、Fencing Token 租约续期，收到手机或其他设备派发的跨设备指令时毫秒级唤醒本地 `remote` Agent 执行。
- **跨设备免能力表调用、双向文件互传与人机协同**：主对话拥有 `anylink_invoke`、`anylink_task_reply`、`anylink_file_send`、`anylink_artifact_upload` 与 `anylink_artifact_download` 工具，可直接通过 `@device_slug`（如 `@my-phone`）发指令、回复挂起的追问/审批任务，或与手机互传大文件；发送前自动通过 `/edge/v1/protocol` 与 `/edge/v1/directory` 预检云端上限与目标 `file_policy`（对方关闭收文件、超单文件上限或剩余空间不足时上传前直接提示）；Mac Worker 启动时自动上报本机 `file_policy` 与真实磁盘剩余空间，收到 `file.deliver` 后先校验上限与磁盘空间再流式校验 SHA-256 并保存到 `~/Downloads/AnyLink/`（防覆盖自动重命名）。
- **直连 HTTPS**：直接连接云端公网 HTTPS 地址（无需常驻 SSH 隧道），断网自动指数退避重连，启动脚本自带 Worker 崩溃自动拉起监控。
- **可选全权限模式 + 历史边界自愈**：默认只开放白名单目录；个人自用电脑可通过 `--full-access` 显式开放完整电脑（含 `/Users/<用户名>` 主目录）、终端与桌面操控权限。Worker 启动时若检测到 `full_access: true`，会自动清除历史学习到的陈旧 `OUTSIDE_ROOT` 边界记忆并写入最新全权限设备事实，避免 `remote` Agent 误判无权限。

---

## 一、首次安装与配置步骤

环境要求：macOS（Apple Silicon / Intel）、Node.js 22+，且已部署好 AnyLink 云端服务器。

### 1. 准备固定 OpenClaw 运行时
```bash
node examples/mac-openclaw/install-runtime.mjs
```

### 2. 一键接入云端服务器（推荐：预设登录密码）
如果服务端在 `.env` / `app.env` 中配置了快捷登录密码 `ANYLINK_LOGIN_PASSWORD`（至少 6 位），直接一条命令接入：
```bash
node examples/mac-openclaw/connect.mjs \
  --server https://YOUR_SERVER_DOMAIN_OR_IP \
  --password "YOUR_LOGIN_PASSWORD" \
  --name "我的 Mac" \
  --slug "home-mac"
```
也可以使用传统加入密钥文件（`--join-key-file secrets/ywc-join-key`），或在通过 SSH 隧道访问时附加 `--ssh-host ywc` 并使用 `--server http://127.0.0.1:3181`。

> 登录密码 / 加入密钥**不会写入磁盘**，脚本只会在 `secrets/mac-connection.json` 中保存云端签发的专属 `ak_...` 设备令牌（权限 `0600`）。

### 3. 配置跨设备 `remote` Agent 权限
- **模式 A：默认安全沙箱（推荐公开 / 多人环境）** — 仅开放 `secrets/mac-peer-policy.json` 里白名单目录（桌面、文稿、下载、项目目录、工作区）的读写整理，删除统一移入废纸篓：
  ```bash
  node examples/mac-openclaw/configure-remote.mjs
  ```
- **模式 B：个人电脑全权限模式（显式启用）** — 开放 OpenClaw 对整台 Mac 的文件、终端命令（`exec`）及桌面工具权限：
  ```bash
  node examples/mac-openclaw/configure-remote.mjs --full-access
  ```
  如同时使用 `anylink_files_*` 文件工具并希望放开目录白名单，在本地 `secrets/mac-peer-policy.json` 中设置 `"full_access": true`（每次调用热读取，无需重启）。

### 4. 配置后台开机自启（LaunchAgent）
```bash
node examples/mac-openclaw/launch-agent.mjs
cp data/mac/com.anylink.openclaw.plist ~/Library/LaunchAgents/com.anylink.openclaw.plist
chmod 600 ~/Library/LaunchAgents/com.anylink.openclaw.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.anylink.openclaw.plist
```

### 5. 可选：安装桌面伴侣与语音组件
```bash
npm run desktop:control:install      # 可选：Mac 桌面控制工具
npm run desktop:companion:configure  # 可选：配置大肥鱼人设与桌面伙伴
npm run desktop:build                # 可选：构建 macOS 桌面端 App
```

---

## 二、常用控制小技巧

Mac 端 OpenClaw 由 macOS LaunchAgent（`com.anylink.openclaw`）在后台常驻运行，关掉终端和浏览器也不会中断。

- **看实时后台日志**：
  ```bash
  tail -f data/mac/logs/service.log
  ```
- **电脑端打开对话界面**：浏览器访问 `http://127.0.0.1:18791/openclaw/`
- **查看云端管理后台**（共享记忆大脑、跨设备任务记录、设备在线状态）：浏览器访问 `http://127.0.0.1:3181/`（若直接公网部署则访问对应后台地址；可用 **预设登录密码 `ANYLINK_LOGIN_PASSWORD`** 或 **`OWNER_TOKEN`** 登录）
- **重启后台服务**（修改配置或升级代码后）：
  ```bash
  launchctl kickstart -k gui/$(id -u)/com.anylink.openclaw
  ```
- **临时暂停 / 恢复后台服务**：
  - 暂停：`launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.anylink.openclaw.plist`
  - 恢复：`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.anylink.openclaw.plist`

---

## 三、本机令牌速查

- **打开电脑端 OpenClaw 网页 (`127.0.0.1:18791/openclaw/`) 需要 Gateway Token**：
  存放在本地 `secrets/mac-gateway-token`，一键复制到剪贴板：
  ```bash
  tr -d '\n' < secrets/mac-gateway-token | pbcopy
  ```
- **登录云端管理后台 (`127.0.0.1:3181/`)**：
  支持直接输入服务器上配置的快捷登录密码 `ANYLINK_LOGIN_PASSWORD`，或输入服务器 `/opt/anylink-agent/secrets/app.env` 中的 `OWNER_TOKEN`。

---

## 四、运行测试

```bash
npm run test:mac
npm run test:companion
npm run test:mac-control
```
