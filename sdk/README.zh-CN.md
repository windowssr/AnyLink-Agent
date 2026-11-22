# AnyLink SDK

[English](README.md) · [接入协议](../protocol/README.zh-CN.md)

不依赖 OpenClaw、Codex 或虚拟形象的 JavaScript／TypeScript SDK。可在自己的项目里接入统一记忆、可选模型代理、设备能力注册、任务领取和结果回传。客户端没有第三方运行时依赖；可选 Node Worker 使用内建 SQLite 保存执行回执。推荐 Node 24，最低 Node 22.13。

## 安装

```bash
npm install https://github.com/windowssr/AnyLink-Agent/releases/download/v0.8.0-preview.1/anylink-agent-sdk-0.1.0.tgz
# 或在项目 checkout 中安装：
npm install ./sdk
```

当前通过 Release 的 tarball 分发，尚未发布到 npm 注册表。

## 在你的项目中使用

```js
import { AnyLinkClient } from '@anylink-agent/sdk';

const link = new AnyLinkClient({
  baseUrl: process.env.ANYLINK_BASE_URL,
  token: process.env.ANYLINK_DEVICE_TOKEN,
});
const context = await link.context(); // 全局事实 + 当前逻辑设备事实

// 由你的应用确认用户有明确保存意图，再写入长期记忆。
const fact = await link.saveMemory({
  title: '语言偏好', content: '使用中文', scope: 'global',
}, { idempotencyKey: crypto.randomUUID() });
await link.updateMemory(fact.id, fact.revision, { content: '中英文都可以' });
```

先在自部署服务的管理页注册逻辑设备，妥善保存一次性显示的设备凭据。主人管理令牌不应交给普通设备。当前是单主人参考服务，各设备位于同一主人信任域；默认上下文按设备选择事实，不代表多租户强隔离。

## 让自己的应用接收任务

```js
import { AnyLinkWorker } from '@anylink-agent/sdk/worker';

// private-state 目录由应用事先创建，加入 .gitignore，并跨重启保留。
const worker = new AnyLinkWorker({
  client: link,
  journalPath: './private-state/receipts.sqlite',
  handlers: {
    'text.reverse': {
      description: '只反转传入文字，不访问电脑文件',
      async execute(input, { signal, task }) {
        signal.throwIfAborted();
        if (typeof input.text !== 'string') throw new Error('Invalid text');
        return { text: [...input.text].reverse().join('') };
      },
    },
  },
});
await worker.recoverResults();
await worker.run({ signal: shutdownSignal });
```

`shutdownSignal` 是应用自己的 AbortSignal。[完整可运行示例](examples/worker.mjs) 包含目录创建、环境变量和退出信号处理。设备先声明能力，主人再为“来源设备 → 目标设备 → 指定能力”授权：

```bash
node scripts/grant-capability.mjs \
  --server http://127.0.0.1:3180 \
  --owner-token-file secrets/local-dev-owner-token \
  --source 来源设备UUID --target 目标设备UUID \
  --capability text.reverse
```

该命令在参考服务工程中执行；加 `--revoke` 可停止后续领取。发送方随后可以创建任务、查询回执：

```js
const task = await link.createTask({
  target_device_id: targetDeviceId,
  capability: 'text.reverse', input: { text: 'AnyLink' },
}, { idempotencyKey: crypto.randomUUID() });
const current = await link.task(task.id);
```

AnyLink 只搬运结构化任务，不把一句提示词当作执行任意命令的授权。具体工具、参数检查、工作区、系统权限与审批由宿主应用负责。

## 模型调用与恢复规则

`chatCompletions()` 和 `streamChatCompletions()` 提供可选模型通路，后者保留文本、工具调用和用量事件。当前参考服务只支持 `deepseek-flash`；接入 SDK 不要求替换宿主已有模型配置。Codex 示例仍使用 Codex 自己的登录和模型。

- SDK 不自动重试模型请求或未知提交。错误对象带有 `code`、`status`、`requestId`、`idempotencyKey`、`submissionUnknown`。
- 丢失响应时用原幂等键核对结果；新一次领取使用新键。空领取不持久占用幂等键，只有实际领取任务才记录结果。
- 服务端不会自动重排已领取任务；本地持久回执阻止同一任务重新执行。保留每个服务／设备身份的同一份 SQLite journal；SDK 会在回传前核对绑定。
- 已保存的结果可以重发；只有 `started`、没有结果的记录需要检查宿主后显式处理。外部副作用无法承诺绝对的“恰好一次”。
- 取消是协作请求。中断不等于外部动作被撤销；无法证明的结果报告 `unknown`。
- 输入和结果对象各限制 64 KiB，任务列表目前只返回最近 100 项，暂未提供分页和流式任务事件。

[Codex 只读适配示例](examples/codex-read-only.mjs) 会在操作者指定的工作区启动独立 CLI 任务，不控制现有 Codex 桌面聊天。[现有 Mac OpenClaw 插件](../mac/plugin) 是完整参考实现，SDK 本身不依赖它。

一个逻辑设备应对应同一能力清单；同一身份并行运行的 Worker 需要共享 journal 和处理器集合。Codex 示例的只读限制指文件系统，MCP／插件和连接器权限仍由操作者配置。

处理器抛异常也可能发生在外部动作完成之后，因此 Worker 默认报告 unknown；应用必须核对副作用，不能把异常当成安全重试的依据。
