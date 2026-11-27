# 边缘架构：安装、使用与运维

适用代码：V0.2 / V0.3。角色分工为 Mac 原生 OpenClaw＋ywc 的记忆与模型 API。V0.3 电脑控制的新增组件、权限与真实完成情况见 [Mac 电脑控制](07-mac-computer-control.md)。

## Mac 目录

- `data/mac/runtime`：固定 Node 24.22.3 与 OpenClaw 2026.11.6；依赖由 `mac/runtime-lock.json` 固定。
- `data/mac/openclaw`：本机 Gateway 配置、session、原生运行状态与编译缓存。
- `data/mac/workspace`：初始工具工作区；原生文件工具限定于该目录。
- `data/mac/logs`：本机服务日志。
- `secrets/mac-connection.json`：云端设备凭据和设备 ID，0600。
- `secrets/mac-gateway-token`：独立的本地 Gateway 管理令牌，0600。

目录和秘密不提交 Git。DeepSeek Key 只配置在 ywc，本机只持有访问自己服务器的设备服务凭据。没有改系统 Node，也不复用用户其他 OpenClaw 状态。

## 重复安装

```bash
cd /Users/yundongwu/self-program/anylink-agent
node mac/install-runtime.mjs
node mac/pair.mjs
node mac/start.mjs
```

安装器先准备独立 bootstrap Node，再按 lock 安装原生 Mac runtime。配对命令通过主人已配置的 `ssh ywc` 访问可信管理入口，设备名使用本机名称；主人令牌与返回凭据都在进程内部传递，不打印。已有连接文件时不自动轮换；明确替换时使用 `node mac/pair.mjs --rotate`，随后重启本机服务。

## 交互

当前 Mac 也可直接双击 `~/Applications/AnyLink.app`，以原生独立窗口使用同一个本机 Agent。构建、更新与界面生命周期详见 [Mac 桌面应用说明](06-mac-desktop.md)。

本机聊天地址为 `http://127.0.0.1:18791/openclaw/`。V0.2.1 使用独立的 `/openclaw` UI 路径，以支持深层聊天页面的直接加载和重连。执行以下命令在默认浏览器打开带本机认证的页面，命令不会打印令牌：

```bash
node mac/cli.mjs open
```

也可通过 `node mac/cli.mjs ...` 调用官方 CLI。例如 `node mac/cli.mjs models list` 或 `node mac/cli.mjs agent --agent main --message '你好' --json`。运行中的 Gateway 拥有本机状态，不另开 `--local` 进程竞争同一目录。

文件工具在配置工作区内运行；进程命令沿用 OpenClaw allowlist / on-miss 审批。首阶段验证原生文件工具，不声称已验证任意 GUI、麦克风或屏幕操作。

## 常驻与断线

`mac/start.mjs` 管理本地 Gateway 和专属 SSH 隧道：本机 3181 → ywc 的回环 3180。隧道断开会重连，本地 Gateway 和 UI 保持运行；云端暂不可达时推理 / 记忆请求报告未完成，不通过重启整个任务来掩盖断线。

`node mac/launch-agent.mjs` 先在项目目录生成可审阅的 `data/mac/com.anylink.openclaw.plist`。首次安装到当前用户目录并启动：

```bash
mkdir -p "$HOME/Library/LaunchAgents"
install -m 600 data/mac/com.anylink.openclaw.plist "$HOME/Library/LaunchAgents/com.anylink.openclaw.plist"
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.anylink.openclaw.plist"
```

之后通过以下命令管理当前用户服务：

```bash
launchctl print gui/$(id -u)/com.anylink.openclaw
launchctl kill SIGTERM gui/$(id -u)/com.anylink.openclaw
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.anylink.openclaw.plist
```

正常重启使用 SIGTERM；LaunchAgent 的停止预算按本机 `launchctl print` 实际报告配置为 60 秒，Gateway 退出后才关闭隧道。更新或停止前先等待本地任务完成；长任务与未知副作用不能依赖系统强制结束自动恢复。停止服务不会删除本机状态或云端事实。日志为本机进程输出，日常排障避免打印完整配置和环境变量。

## 云端

Compose 只定义 app、postgres 两服务。产品入口仍只绑定 `127.0.0.1:3180`；app 从 `secrets/model.env` 读取服务端 DeepSeek Key，直连配置的提供商。模型地址不接受调用者提供的任意 URL。

模型 API：`/model/v1/models`、`/model/v1/chat/completions`、`/model/v1/speech`（文字净化＋可选口播改写＋语音合成：默认微软神经语音 MP3；配置百炼 Key 时优先 Qwen Momo，默认返回 WAV；请求 `Accept: application/x-ndjson` 时分片返回 PCM。首段音频前失败可回退原微软语音，设备 Bearer 凭据；合成失败返回 502 `SPEECH_UNAVAILABLE` 并附 `spoken_text` 供客户端回退）。记忆 API：`/edge/v1/context` 与 `/edge/v1/memories...`。均使用设备 Bearer 凭据。设备登记、凭据生成 / 撤销和模型元数据由主人管理；服务凭据不能调用主人管理接口。

每台设备同时一个推理请求，服务总并发两个，单请求输出上限 8192 tokens，默认 4096；单设备每分钟最多 30 次模型请求。代理不自动重发未知上游调用，保存请求 ID、设备、状态与用量，不保存模型输入 / 输出正文。

云端管理页只管理记忆、服务凭据和模型用量，不能在此执行聊天。旧云端对话、运行和任务 API 返回 410；历史表保留，不转换为可执行队列。

## 发布与回退

沿用按提交构建、内容指纹验证、独立数据库备份和 current / previous 切换。V0.2 数据库迁移是新增设备凭据摘要与模型请求元数据，不删除 V0.1 事实和历史数据。

V0.1 回退包会重新启用云端原型且缺少新模型 API，应视为架构回退；日常更新优先回退到另一 V0.2 发布。不得自动把旧聊天和待办重新执行。

旧云端 OpenClaw 容器停止并禁用自动重启，旧状态目录保留用于历史导出。只操作本项目，不修改现有 caststorage 服务。
