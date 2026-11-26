# `@anylink-agent/sdk`

[English](README.md) · [协议 v3](../protocol/README.zh-CN.md) · [Python SDK](../sdk-python/README.md) · [MCP 适配器](../mcp/README.md)

面向 **AnyLink 协议 v3** 的零依赖 JavaScript/TypeScript SDK（Node >= 22）：

- **云端记忆大脑**：按需混合检索与上下文组装（`assembleMemory`）、异步事件摄入整理（`ingestMemory`）与显式 CRUD。
- **多模型网关**：OpenAI 兼容同步/SSE 流式调用，支持 `autoMemory: true` 一键开启云端自动记忆注入与归档。
- **无能力前置约束的跨设备调用**：边缘节点无需知晓对方能力表，直接通过 `invoke()` 发送指令；接收方通过 WebSocket 实时接单、自动心跳续租，遇到本机无法完成的任务抛出 `TaskDeclined`，云端记忆大脑自动学习该设备边界。
- **零依赖防重放日志**：内置持久化 JSONL 日志（`FileJournal`），不再依赖实验性 `node:sqlite`。

## 快速上手

```js
import { AnyLinkClient } from '@anylink-agent/sdk';
import { AnyLinkWorker, TaskDeclined } from '@anylink-agent/sdk/worker';

const joined = await AnyLinkClient.connect({
  baseUrl: process.env.ANYLINK_BASE_URL,
  joinKey: process.env.ANYLINK_JOIN_KEY,
  installId: 'server-prod-01',
  device: { name: '构建服务器', platform: 'linux' },
  agent: { key: 'builder', name: '构建 Agent', summary: '负责代码构建与服务部署' },
});

const client = new AnyLinkClient({ baseUrl: process.env.ANYLINK_BASE_URL, token: joined.token });

// 1. 拉取相关跨设备共享记忆与设备边界
const mem = await client.assembleMemory({ query: '上周的报告放在哪台设备？' });

// 2. 向其他设备直接发任务（无需查询能力表）
const task = await client.invoke({ target: { device_name: 'Mac' }, instruction: '帮我列出桌面的报告文件' });
const done = await client.waitForTask(task.id);

// 3. 作为边缘节点通过 WebSocket 实时接单，只管理自己本地环境
const worker = new AnyLinkWorker({
  client,
  journalPath: './private-state/journal.jsonl',
  async onInvoke(task, { reportProgress }) {
    if (task.instruction?.includes('发微信')) {
      throw new TaskDeclined('UNSUPPORTED_APP', 'Linux 服务器不支持微信操作');
    }
    await reportProgress({ stage: 'working', message: '正在执行', percent: 50 });
    return { reply: `已在服务器完成：${task.instruction}` };
  },
});

await worker.recoverResults();
await worker.run();
```
