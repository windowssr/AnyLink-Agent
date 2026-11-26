<p align="center"><img src="docs/assets/banner.svg" alt="AnyLink Agent — 通用协议与 SDK" width="100%"></p>

<p align="center"><a href="README.md">English</a> · <a href="protocol/README.zh-CN.md">协议 v3</a> · <a href="sdk-python/README.md">Python SDK (PyPI)</a> · <a href="sdk/README.zh-CN.md">TypeScript SDK (npm)</a> · <a href="mcp/README.md">MCP 适配器</a> · <a href="LICENSE">MIT</a></p>

# AnyLink Agent

**个人 Agent 网络 —— 边缘自治、云端记忆大脑、多模型网关与 WebSocket 实时协同。**

AnyLink（`Protocol v3`）把 **模型 API 调用** 与 **跨设备共享记忆** 统一收口到你的私有云端中枢，让电脑、服务器、手机等各边缘设备上的 Agent 天然共享记忆并顺畅互调：

- **云端记忆大脑（`POST /edge/v1/memory/assemble`、`POST /edge/v1/memory/ingest`）**：中英文混合分词 + 可选向量检索、LLM 驱动的异步记忆提取/去重/合并、跨设备近期动态摘要，以及**跨设备能力边界自动学习**。
- **云端多模型网关（`POST /model/v1/chat/completions`）**：支持多模型与多提供商路由、按 Agent 独立并发控制，并提供可选的**自动共享记忆模式**（`X-AnyLink-Auto-Memory: on`）。
- **无能力前置约束的跨设备调用 + WebSocket 实时总线（`GET /edge/v1/ws`）**：边缘设备只需管好自己的本地环境，无需事先维护其他设备的能力表。直接向目标设备发指令，对方若做不到则返回 `declined` 与原因，云端记忆大脑自动将其沉淀为设备边界，后续各设备加载上下文后自然学会。全程支持 WS 实时推送、进度流、租约心跳与 HTTP 降级。
- **开源封装生态**：
  - **Python SDK（`sdk-python/`，PyPI `anylink-agent`）**：异步客户端 + `@agent.on_invoke` 装饰器 WebSocket 节点 + 零依赖持久化回执日志。
  - **TypeScript SDK（`sdk/`，npm `@anylink-agent/sdk`）**：零第三方依赖（Node >= 22）、内置 WebSocket 客户端与 `FileJournal`。
  - **MCP 适配器（`mcp/`，`@anylink-agent/mcp`）**：一行配置即可把 Claude Code、Cursor、Codex、OpenClaw 接入你的个人 Agent 网络。
- **配套参考客户端（“蓝色大肥鱼”）**：Mac OpenClaw 桌宠与 Android 原生陪伴应用（第二阶段迁移至 Protocol v3）。

<img src="docs/assets/architecture.svg" alt="应用、AnyLink SDK、云端中继和宿主适配器的架构" width="100%">

**Android 0.3+ 只连接 AnyLink 服务器，不连接 Mac Gateway。** Mac 关机时，手机仍能聊天、使用本机工具和共同记忆；交给 Mac 的任务经云端排队、领取和返回。Android 0.2.x 为历史 companion 预览，连接方式已退出产品主线。Codex 示例仍是独立只读 CLI 任务，不操控现有桌面聊天。

## 下载安装包

当前公开版本为 **v0.8.1-preview.1**。资源、源码提交和 SHA-256 一起保存在 [GitHub Releases](https://github.com/windowssr/AnyLink-Agent/releases/tag/v0.8.1-preview.1)：

- [Android APK](https://github.com/windowssr/AnyLink-Agent/releases/download/v0.8.1-preview.1/AnyLink-Android-0.3.0-preview.1.apk)：Android 12+，开发预览签名。
- [Mac App](https://github.com/windowssr/AnyLink-Agent/releases/download/v0.8.1-preview.1/AnyLink-macOS-arm64-0.8.1-preview.zip)：Apple Silicon、macOS 15+；是连接已配置工程的桌面壳，首次启动选择你自己的项目目录。语音输入要求 macOS 26。预览包采用 ad-hoc 签名，未公证，安装方式见[参考客户端说明](docs/open-source/clients.md)。
- [SDK 安装包](https://github.com/windowssr/AnyLink-Agent/releases/download/v0.8.1-preview.1/anylink-agent-sdk-0.1.1.tgz)：可安装到自己的 Node／TypeScript 项目，尚未发布 npm 注册表。

公开包**不包含大肥鱼模型、纹理、派生头像或 Live2D Cubism Core**。默认使用原创代码绘制的占位形象。第三方模型须自行从作者来源获取，并遵守各自许可；MIT 不授予角色或模型再分发权。

## 手机如何连接

在 App 的“服务器连接”中填写 **AnyLink HTTPS 地址**和主人签发的**加入密钥**（可选填设备名称）。从 0.4.0-preview.1 起手机以 `android-dafeiyu` Agent 身份接入，加入密钥只用于本次请求、不落盘。旧版一次性设备凭据 JSON 仍可导入，存量旧凭据会先认领 install_id，使新 Agent 保留同一设备与设备级记忆。不需要 Mac 的地址、OpenClaw Token 或配对。服务器负责调用模型，手机自己完成工具循环。远程使用需要部署者提供可达的 HTTPS 入口，USB／SSH 只用于开发调试。详见[手机客户端连接与无域名 HTTPS](docs/open-source/phone-connection.md)和[客户端说明](docs/open-source/clients.md)。

## 展示

<p><img src="docs/assets/android-public.jpg" alt="公开版原创占位形象的电脑浏览器预览" width="45%"> <img src="docs/assets/android-optional-character.jpg" alt="自行配置第三方大肥鱼模型后的电脑预览，模型未包含在公开包中" width="45%"></p>

左：公开版的原创占位形象。右：本机自行配置第三方模型后的效果。两图均为**电脑浏览器构图预览，不是真机截图**。右侧 DeepSeek-chan／大肥鱼原画及拆分：**神宫凉子**；Live2D：**霓虹猫_NeonNeko**；[模型来源与使用须知](https://github.com/YJackie-Li/DeepSeek-chan/blob/main/README.md)。

原生服务器连接页的 UI 测试渲染图（不是真机截图）：

<img src="docs/assets/android-server-connection.png" alt="Android AnyLink server connection" width="300">

## 先把 SDK 接进自己的项目

```bash
npm install https://github.com/windowssr/AnyLink-Agent/releases/download/v0.8.1-preview.1/anylink-agent-sdk-0.1.1.tgz
```

```js
import { AnyLinkClient } from '@anylink-agent/sdk';

const joined = await AnyLinkClient.connect({
  baseUrl: process.env.ANYLINK_BASE_URL,
  joinKey: process.env.ANYLINK_JOIN_KEY,
  installId: process.env.ANYLINK_INSTALL_ID,
  device: { name: '构建服务器', platform: 'other' },
  agent: { key: 'builder', name: '构建 Agent' },
});
const link = new AnyLinkClient({ baseUrl: process.env.ANYLINK_BASE_URL, token: joined.token });
const context = await link.context();
const task = await link.createTask({
  target: { agent_id: targetAgentId },
  capability: 'text.reverse',
  input: { text: 'AnyLink' },
}, { idempotencyKey: crypto.randomUUID() });
```

一个加入密钥即可连接任意设备和 Agent，没有逐对授权。完整 Worker、Agent 路由、结果恢复和可选模型调用见 [SDK 中文说明](sdk/README.zh-CN.md)。只需接记忆时，使用 `context()` 等接口即可，不需要替换已有 Agent 或模型。

## 自部署参考服务

需要 Node 24、npm 和 Docker Compose；只有可选模型代理需要你自己的模型服务 Key。

```bash
git clone https://github.com/windowssr/AnyLink-Agent.git
cd AnyLink-Agent
npm ci
node scripts/init-local.mjs
# 如需模型代理，在生成的 .env 填写 DEEPSEEK_API_KEY；不要提交 .env。
docker compose --env-file .env -f deploy/compose.local.yaml up -d --wait
npm run build
node --env-file=.env dist/server/index.js
```

访问 `http://127.0.0.1:3180`，使用 `secrets/local-dev-owner-token` 中的主人令牌登录。`init-local.mjs` 同时生成 `secrets/local-dev-join-key`；设备通过 `AnyLinkClient.connect` 或 `POST /edge/v1/connect` 接入。“设备访问”页面列出设备及其 Agent 供查看和吊销，也仍可为设备 `default` Agent 签发旧版一次性凭据。主人令牌、加入密钥、设备凭据与模型 Key 各自独立。

默认端口仅监听回环。远程使用 HTTPS 或 SSH 隧道；不要直接公开当前本机 Gateway。生产 Compose、发布与回退脚本保留在 `deploy/`、`scripts/`，先阅读[部署说明](docs/open-source/self-hosting.md)。

## 开发和参考实现

```bash
npm run check
npm run test:sdk
npm run protocol:check
npm run build
# 仅在一次性 anylink_test 数据库上执行；会重建其 schema：
TEST_DATABASE_URL=postgresql://USER:PASS@127.0.0.1:5432/anylink_test npm run test:integration
```

- [接入协议与 OpenAPI](protocol/README.zh-CN.md)：HTTP、身份、能力、状态、幂等和恢复约定。
- [SDK](sdk/README.zh-CN.md)：独立宿主 Worker、记忆和流式模型接口。
- [Codex 只读适配示例](sdk/examples/codex-read-only.mjs)：宿主自选工作区，不绕过审批。
- [Mac／Android 参考客户端](docs/open-source/clients.md)：安装、权限、连接和可选模型配置。
- [已有产品设计文档](docs/product/README.md)：历史探索与交互设计，不代表全部功能已交付。

## 当前边界

服务是**单主人参考部署**。逻辑设备处于同一主人信任域，默认上下文选择不等于多租户数据隔离，也不证明物理设备已配对。加入密钥让任何持有者都能连接并向任意 Agent 派发任务，真正的执行边界是每台宿主的本地策略。取消是协作请求，外部副作用不能承诺绝对“恰好一次”。服务器可读取记忆、任务和转发的模型内容。

Android 原生 Agent 已接通通用云端协议；尚未发布独立 Kotlin SDK。手机工具当前限于基础状态、私有便笺、统一记忆与跨设备任务，尚不能通用控制其他 App。没有 Codex 现有桌面会话控制或端到端实时语音承诺；APK 的收音、播放、GPU 和后台生命周期仍待真机验收。详见[安全边界](SECURITY.md)。

## 开源与双仓库维护

项目原创代码与文档采用 [MIT](LICENSE)，第三方代码与素材见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。

[GitHub](https://github.com/windowssr/AnyLink-Agent) 与 [Gitee](https://gitee.com/windowssr/anylink-agent) 维护同一 `main` 和版本标签；安装资源统一存放 GitHub Releases，两边 README 指向同一资源。维护者使用 `npm run repo:sync` 检查分歧后双推送，遇到外部提交先合并，禁止强制覆盖。欢迎提交接入适配器和协议改进，见 [CONTRIBUTING](CONTRIBUTING.md)。
