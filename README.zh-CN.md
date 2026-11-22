<p align="center"><img src="docs/assets/banner.svg" alt="AnyLink Agent — 通用协议与 SDK" width="100%"></p>

<p align="center"><a href="README.md">English</a> · <a href="https://github.com/windowssr/AnyLink-Agent/releases/tag/v0.8.0-preview.1">下载安装包</a> · <a href="sdk/README.zh-CN.md">SDK</a> · <a href="protocol/README.zh-CN.md">接入协议</a> · <a href="LICENSE">MIT</a></p>

# AnyLink Agent

**把你的 Agent 接到更多设备，让记忆共享，让执行留在宿主。**

AnyLink 提供可自部署的云端记忆、可选模型代理、设备任务协议和 JavaScript／TypeScript SDK。它不绑定某一个 Agent 框架：你可以接入自己的应用、自动化系统、Codex 适配器或其他 Agent。仓库中的 Mac／Android OpenClaw 改版是参考客户端。

## 已实现

- **通用 SDK**：读取全局／设备上下文，保存与修订记忆，流式模型调用，注册能力，下发任务并查询真实结果。
- **设备任务通路**：主人明确授予“来源设备 → 目标设备 → 能力”，目标宿主领取任务、本机执行、回传持久回执。
- **失败语义**：幂等写入、revision 条件、持久执行 journal、未知结果显式报告；不会自动重跑未知模型请求或外部操作。
- **自部署服务**：TypeScript、Fastify、PostgreSQL；云端不运行 Agent 工具循环。
- **参考客户端**：Mac `.app` 的聊天、电脑控制和桌面伙伴；官方 OpenClaw Android 改版的聊天、Talk 与形象状态。语音、取消和手机操作仍需各自系统权限与真机验证。

<img src="docs/assets/architecture.svg" alt="应用、AnyLink SDK、云端中继和宿主适配器的架构" width="100%">

通用协议和 SDK 已能独立接入项目。当前下载的 Mac／Android 软件仍使用 OpenClaw 传输，尚不是通用 AnyLink 手机控制器。Codex 示例启动独立的只读 CLI 任务，不操控现有桌面聊天；后续可通过受支持的会话／app-server 接口扩展。

## 下载安装包

当前公开版本为 **v0.8.0-preview.1**。资源、源码提交和 SHA-256 一起保存在 [GitHub Releases](https://github.com/windowssr/AnyLink-Agent/releases/tag/v0.8.0-preview.1)：

- [Android APK](https://github.com/windowssr/AnyLink-Agent/releases/download/v0.8.0-preview.1/AnyLink-Android-0.2.0-preview.2.apk)：Android 12+，开发预览签名。
- [Mac App](https://github.com/windowssr/AnyLink-Agent/releases/download/v0.8.0-preview.1/AnyLink-macOS-arm64-0.8.0-preview.zip)：Apple Silicon、macOS 15+；是连接已配置工程的桌面壳，首次启动选择你自己的项目目录。语音输入要求 macOS 26。预览包采用 ad-hoc 签名，未公证，安装方式见[参考客户端说明](docs/open-source/clients.md)。
- [SDK 安装包](https://github.com/windowssr/AnyLink-Agent/releases/download/v0.8.0-preview.1/anylink-agent-sdk-0.1.0.tgz)：可安装到自己的 Node／TypeScript 项目，尚未发布 npm 注册表。

公开包**不包含大肥鱼模型、纹理、派生头像或 Live2D Cubism Core**。默认使用原创代码绘制的占位形象。第三方模型须自行从作者来源获取，并遵守各自许可；MIT 不授予角色或模型再分发权。

## 展示

<p><img src="docs/assets/android-public.jpg" alt="公开版原创占位形象的电脑浏览器预览" width="45%"> <img src="docs/assets/android-optional-character.jpg" alt="自行配置第三方大肥鱼模型后的电脑预览，模型未包含在公开包中" width="45%"></p>

左：公开版的原创占位形象。右：本机自行配置第三方模型后的效果。两图均为**电脑浏览器构图预览，不是真机截图**。右侧 DeepSeek-chan／大肥鱼原画及拆分：**神宫凉子**；Live2D：**霓虹猫_NeonNeko**；[模型来源与使用须知](https://github.com/YJackie-Li/DeepSeek-chan/blob/main/README.md)。

## 先把 SDK 接进自己的项目

```bash
npm install https://github.com/windowssr/AnyLink-Agent/releases/download/v0.8.0-preview.1/anylink-agent-sdk-0.1.0.tgz
```

```js
import { AnyLinkClient } from '@anylink-agent/sdk';

const link = new AnyLinkClient({
  baseUrl: process.env.ANYLINK_BASE_URL,
  token: process.env.ANYLINK_DEVICE_TOKEN,
});
const context = await link.context();
const task = await link.createTask({
  target_device_id: targetDeviceId,
  capability: 'text.reverse',
  input: { text: 'AnyLink' },
}, { idempotencyKey: crypto.randomUUID() });
```

目标宿主需先注册能力，主人需明确授权。完整 Worker、授权步骤、结果恢复和可选模型调用见 [SDK 中文说明](sdk/README.zh-CN.md)。只需接记忆时，使用 `context()` 等接口即可，不需要替换已有 Agent 或模型。

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

访问 `http://127.0.0.1:3180`，使用 `secrets/local-dev-owner-token` 中的主人令牌登录。在“设备访问”注册逻辑设备，生成并私下保存一次性凭据 JSON；将设备 Token 配给自己的 SDK 实例。主人令牌、设备凭据与模型 Key 各自独立。

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

服务是**单主人参考部署**。逻辑设备处于同一主人信任域，默认上下文选择不等于多租户数据隔离，也不证明物理设备已配对。执行还受能力授权与宿主本地策略控制。取消是协作请求，外部副作用不能承诺绝对“恰好一次”。服务器可读取记忆、任务和转发的模型内容。

当前没有通用 Android SDK、通用手机客户端连接层、Codex 现有桌面会话控制或端到端实时语音承诺。APK 的收音、播放、打断、GPU 和手机节点操作仍待真机验收。详见[安全边界](SECURITY.md)。

## 开源与双仓库维护

项目原创代码与文档采用 [MIT](LICENSE)，第三方代码与素材见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。

[GitHub](https://github.com/windowssr/AnyLink-Agent) 与 [Gitee](https://gitee.com/windowssr/anylink-agent) 维护同一 `main` 和版本标签；安装资源统一存放 GitHub Releases，两边 README 指向同一资源。维护者使用 `npm run repo:sync` 检查分歧后双推送，遇到外部提交先合并，禁止强制覆盖。欢迎提交接入适配器和协议改进，见 [CONTRIBUTING](CONTRIBUTING.md)。
