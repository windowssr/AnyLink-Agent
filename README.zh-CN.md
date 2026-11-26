<p align="center">
  <img src="docs/assets/hero-banner.jpg" alt="AnyLink Agent — Personal Agent Network with Cloud Memory Brain" width="100%" />
</p>

<h1 align="center">AnyLink Agent</h1>

<p align="center">
  <strong>你的个人 Agent 网络：把记忆与模型留在云端大脑，让执行自由分布在每一台设备。</strong>
</p>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/lang-English-0ea5e9?style=flat-square" alt="English" /></a>
  <a href="protocol/README.zh-CN.md"><img src="https://img.shields.io/badge/Protocol-v3.0-22d3ee?style=flat-square" alt="Protocol v3.0" /></a>
  <a href="sdk-python/README.md"><img src="https://img.shields.io/badge/Python-anylink--agent-3776ab?style=flat-square&logo=python&logoColor=white" alt="Python SDK" /></a>
  <a href="sdk/README.zh-CN.md"><img src="https://img.shields.io/badge/TypeScript-@anylink--agent%2Fsdk-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript SDK" /></a>
  <a href="mcp/README.md"><img src="https://img.shields.io/badge/MCP-@anylink--agent%2Fmcp-10b981?style=flat-square" alt="MCP Server" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-64748b?style=flat-square" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="#为什么做-anylink">设计理念</a> ·
  <a href="#整体架构">整体架构</a> ·
  <a href="#10-行代码接入你的设备">快速接入</a> ·
  <a href="#蓝色大肥鱼参考客户端">蓝色大肥鱼展示</a> ·
  <a href="#自部署云端中枢">自部署</a> ·
  <a href="protocol/README.zh-CN.md">Protocol v3 规范</a>
</p>

---

## 为什么做 AnyLink？

今天大多数 AI Agent 都被困在单台设备里：电脑上的 Agent 不知道你手机上刚聊过什么，服务器上的脚本和桌面工具各自维护孤立的上下文，跨设备协作还要写一堆脆弱的能力注册表和轮询胶水。

**AnyLink 提出一种全新的个人 Agent 网络架构 —— 「云端记忆大脑 + 边缘设备自治」：**

| 维度 | 传统单机 / 云端强控 Agent | **AnyLink Protocol v3** |
| --- | --- | --- |
| **记忆归属** | 分散在各设备本地文件，换台设备就失忆 | **云端记忆大脑统一管理**：混合分词+向量检索、去抖批整理、自动去重合并，跨设备天然共享 |
| **模型 API** | 每台设备单独填 Key、换模型逐台改配置 | **云端多模型网关**：Key 永不离开服务器、支持多模型别名与可选自动记忆模式（`X-AnyLink-Auto-Memory: on`） |
| **跨设备调用** | 先查死板的能力表、短轮询延迟高、断线任务永久卡死 | **WebSocket 实时总线 + 无能力表直调**：用 `@home-mac` 唯一短别名直接发指令，自带租约心跳防卡死 |
| **能力边界演进** | 手动维护 JSON Schema，改一点全网失效 | **自学习设备边界**：对方做不到直接返回 `declined`，云端自动记成全局边界，全网 Agent 越用越懂彼此 |
| **生态接入** | 绑定某个特定框架 | **引擎无关开源协议**：提供 **Python SDK (PyPI)**、**TypeScript SDK (npm)** 与 **零代码 MCP 适配器** |

<p align="center">
  <img src="docs/assets/network-showcase.jpg" alt="AnyLink Cross-Device Personal Agent Network" width="92%" />
</p>

---

## 整体架构

<p align="center">
  <img src="docs/assets/architecture.svg" alt="AnyLink Protocol v3 Architecture" width="100%" />
</p>

### 亮点机制：边缘只管自己，云端大脑越用越聪明

每台边缘设备**不需要关心其他设备有什么能力**，只需要管好自己所在的本地环境和安全策略：

<p align="center">
  <img src="docs/assets/boundary-learning.svg" alt="Capability-free invocation and automatic boundary learning" width="100%" />
</p>

- **唯一短别名（`device_slug`）**：即使你有两台同名的 Mac，也能用 `@home-mac`、`@office-mac` 精确寻址；同名歧义自动返回 `409 AMBIGUOUS_TARGET_DEVICE` 并提示候选别名。
- **去抖动 + 闲聊过滤**：连续对话按会话窗口（默认 15 秒 / 6 轮）合并为**单次**云端记忆整理调用，短闲聊（“好的 / 你好 / 嗯”）直接跳过 0 消耗；而设备拒绝/失败边界会**立即落盘学习**。
- **可靠执行语义**：所有写操作带幂等键，边缘本地零依赖持久化 JSONL 回执日志（`FileJournal`），崩溃或超租约转为 `unknown`，绝不盲目重跑带副作用的操作。

---

## 10 行代码接入你的设备

### 方式一：Python SDK（PyPI `anylink-agent`）—— 适合 Linux 服务器 / 脚本 / LangGraph / CrewAI

```bash
pip install anylink-agent   # 或本地源码安装：uv pip install -e ./sdk-python
```

```python
import asyncio, os
from anylink import AnyLinkAgent, AnyLinkClient, TaskContext, TaskDeclined

async def main():
    joined = await AnyLinkClient.connect(
        base_url=os.environ["ANYLINK_BASE_URL"], join_key=os.environ["ANYLINK_JOIN_KEY"],
        install_id="gpu-server-01", device_name="GPU 服务器", device_slug="gpu-box",
        platform="linux", agent_key="worker", agent_name="GPU Agent",
    )
    async with AnyLinkClient(os.environ["ANYLINK_BASE_URL"], joined["token"]) as client:
        # 1. 拉取跨设备共享记忆与设备边界
        mem = await client.assemble_memory(query="最近在跑哪个训练任务？")
        # 2. 调云端多模型网关（可选开启自动共享记忆）
        reply = await client.chat_completions(model="default", messages=[{"role": "user", "content": "总结进度"}], auto_memory=True)
        # 3. WebSocket 实时接单：只需管好本机环境，做不到直接 TaskDeclined
        agent = AnyLinkAgent(client, journal_path="./private-state/journal.jsonl")

        @agent.on_invoke
        async def handle(task: dict, ctx: TaskContext):
            if "微信" in (task.get("instruction") or ""):
                raise TaskDeclined("UNSUPPORTED", "Linux 服务器没有微信")
            await ctx.report_progress(stage="working", message="检查 GPU 状态中", percent=50)
            return {"reply": f"已完成：{task['instruction']}"}

        await agent.run()

asyncio.run(main())
```

### 方式二：TypeScript SDK（npm `@anylink-agent/sdk`）—— 零第三方依赖，Node >= 22

```js
import { AnyLinkClient } from '@anylink-agent/sdk';
import { AnyLinkWorker, TaskDeclined } from '@anylink-agent/sdk/worker';

const joined = await AnyLinkClient.connect({
  baseUrl: process.env.ANYLINK_BASE_URL, joinKey: process.env.ANYLINK_JOIN_KEY,
  installId: 'home-mac-01',
  device: { name: 'MacBook Pro', slug: 'home-mac', platform: 'macos' },
  agent: { key: 'desktop', name: 'Mac Agent' },
});
const client = new AnyLinkClient({ baseUrl: process.env.ANYLINK_BASE_URL, token: joined.token });

// 直接按唯一短别名向另一台设备发任务并实时等待完成
const task = await client.invoke({ target: { device_slug: 'gpu-box' }, instruction: '查看当前显存占用' });
const done = await client.waitForTask(task.id);
```

### 方式三：零代码接入 Claude Code / Cursor / Codex（MCP Server）

把 [mcp/bin/anylink-mcp.mjs](mcp/bin/anylink-mcp.mjs) 配进你的 MCP 客户端，立刻获得云端共享记忆检索/沉淀与跨设备调用能力：

```json
{
  "mcpServers": {
    "anylink": {
      "command": "node",
      "args": ["/path/to/anylink-agent/mcp/bin/anylink-mcp.mjs"],
      "env": {
        "ANYLINK_BASE_URL": "https://your-anylink-server.example",
        "ANYLINK_TOKEN": "ak_..."
      }
    }
  }
}
```

---

## 蓝色大肥鱼参考客户端

除了中立、通用的核心协议与 SDK，仓库内置了以**深海蓝白鲸鱼娘「大肥鱼」**为交互卖点的配套参考客户端（核心协议层与角色完全解耦，开源接入无需携带角色）：

- **电脑端（Mac + OpenClaw）**：基于 OpenClaw 挂载记忆与文件工具插件，搭配桌面 Live2D 桌宠与本地语音交互。
- **手机端（Android 原生独立 Agent）**：手机端独立运行对话与无障碍控屏、后台 Live2D 悬浮陪伴与语音播报，不依赖 Mac 在线；需要操作电脑时通过云端无缝协同。

<p align="center">
  <img src="docs/assets/android-public.jpg" alt="公开版原创占位形象预览" width="42%" />
  <img src="docs/assets/android-optional-character.jpg" alt="自行配置可选第三方大肥鱼角色预览（公开包不含）" width="42%" />
</p>

<p align="center">
  <sub>左：公开版原创占位形象；右：本地自行配置第三方角色预览（两图均为桌面浏览器构图预览，非真机截图）。<br/>
  公开仓库与发布包<strong>不包含</strong>第三方 Live2D 模型、纹理与 Cubism Core；DeepSeek-chan 原画/拆分：神宫凉子，Live2D：霓虹猫_NeonNeko，详见 <a href="THIRD_PARTY_NOTICES.md">THIRD_PARTY_NOTICES.md</a>。</sub>
</p>

---

## 自部署云端中枢

环境要求：Node 22+、npm、Docker Compose（PostgreSQL 16/17 标准镜像即可，无需强制扩展）。

```bash
git clone https://github.com/windowssr/AnyLink-Agent.git
cd AnyLink-Agent
npm ci
node scripts/init-local.mjs
# 可选：在 .env 中配置 DEEPSEEK_API_KEY 或 ANYLINK_MODELS_JSON 多模型路由（切勿提交 .env）
docker compose --env-file .env -f deploy/compose.local.yaml up -d --wait
npm run build
node --env-file=.env dist/server/index.js
```

浏览器访问 `http://127.0.0.1:3180`，使用 `secrets/local-dev-owner-token` 登录管理台查看共享记忆、跨设备动态、在线设备（含 `WS 实时在线` 状态）与模型用量。公网 HTTPS 部署与备份回滚脚本见 [docs/open-source/self-hosting.md](docs/open-source/self-hosting.md)。

---

## 仓库结构与路线图

```text
protocol/     # Protocol v3 规范文档与自动生成的 OpenAPI 3.1 契约
server/       # 云端中枢（记忆大脑 + 多模型网关 + WebSocket 实时总线 + 管理台 API）
sdk/          # @anylink-agent/sdk — 零依赖 TypeScript/JS SDK (npm)
sdk-python/   # anylink-agent — Python 异步 SDK 与装饰器边缘节点 (PyPI)
mcp/          # @anylink-agent/mcp — Claude Code / Cursor / Codex MCP 适配器
web/          # 云端管理后台（React + Vite）
mac/          # 参考展示：Mac OpenClaw 插件、文件沙箱与大肥鱼桌宠
android-native/ # 参考展示：Android 原生大肥鱼客户端与悬浮陪伴
```

- [x] **第一阶段**：Protocol v3.0 规范、云端记忆大脑（混合检索 + 去抖批整理 + 边界自动学习）、多模型网关与 1A 自动记忆、WebSocket 实时总线与租约回收、设备唯一短别名 `slug`、Python SDK、TypeScript SDK、MCP Server。
- [x] **第二阶段**：Mac OpenClaw 插件与 Worker（凭据热重载、v3 `memory/assemble` & `memory/ingest`、`anylink_invoke`、WebSocket 长连接、`[ANYLINK_DECLINED]` 边界回传）及 Android 原生大肥鱼客户端（OkHttp WebSocket 实时推送、跨设备结果主动语音汇报、聊天/Worker 客户端隔离与并发取消修复、`device_slug` 接入、`task_invoke` 与 `declined` 边界学习）已全部迁移至 Protocol v3。
- [ ] **第三阶段**：正式发布 `anylink-agent` 至 PyPI、发布 `@anylink-agent/sdk` 与 `@anylink-agent/mcp` 至 npm，以及更多生态框架适配器（LangGraph / CrewAI / AutoGen）。

---

## 开源与安全

- 本项目原创代码与文档采用 [MIT License](LICENSE)，详见 [SECURITY.md](SECURITY.md) 与 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 代码同步托管于 [GitHub](https://github.com/windowssr/AnyLink-Agent) 与 [Gitee](https://gitee.com/windowssr/anylink-agent)。如果这套「云端记忆大脑 + 边缘自治」的个人 Agent 网络思路对你有启发，欢迎点个 **Star** 或提交适配器 PR！
