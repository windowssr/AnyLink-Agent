# `@anylink-agent/sdk`

[简体中文](README.zh-CN.md) · [Protocol v3](../protocol/README.md) · [Python SDK](../sdk-python/README.md) · [MCP Adapter](../mcp/README.md)

Zero-dependency JavaScript/TypeScript SDK for **AnyLink Protocol v3** (Node >= 22):

- **Cloud Memory Brain**: hybrid context assembly (`assembleMemory`) + asynchronous turn/outcome ingestion (`ingestMemory`) + explicit CRUD.
- **Multi-Model Gateway**: OpenAI-compatible `chatCompletions` / `streamChatCompletions` with optional `autoMemory: true` header.
- **Capability-free Cross-Device Invocation**: send natural-language instructions or structured inputs via `invoke()`; receive tasks in real time over WebSocket with automatic lease heartbeats, progress reporting, and `TaskDeclined` boundary learning.
- **Crash-safe local journal**: zero-dependency durable JSONL journal (`FileJournal`), no native binaries or experimental SQLite required.

## Quickstart

```js
import { AnyLinkClient } from '@anylink-agent/sdk';
import { AnyLinkWorker, TaskDeclined } from '@anylink-agent/sdk/worker';

const joined = await AnyLinkClient.connect({
  baseUrl: process.env.ANYLINK_BASE_URL,
  joinKey: process.env.ANYLINK_JOIN_KEY,
  installId: 'server-prod-01',
  device: { name: 'Build Server', platform: 'linux' },
  agent: { key: 'builder', name: 'Build Agent', summary: 'Runs CI builds and Docker deploys' },
});

const client = new AnyLinkClient({ baseUrl: process.env.ANYLINK_BASE_URL, token: joined.token });

// 1. Assemble relevant cross-device memory before answering a user
const mem = await client.assembleMemory({ query: 'Where did I put the release notes?' });
console.log(mem.summary_text);

// 2. Call the cloud model gateway (optionally with auto-memory enabled)
const completion = await client.chatCompletions(
  { model: 'default', messages: [{ role: 'user', content: 'Summarize today work' }] },
  { autoMemory: true },
);

// 3. Receive cross-device tasks over WebSocket — manage only your own environment
const worker = new AnyLinkWorker({
  client,
  journalPath: './private-state/journal.jsonl',
  async onInvoke(task, { reportProgress }) {
    if (task.instruction?.includes('WeChat')) {
      throw new TaskDeclined('UNSUPPORTED_APP', 'This Linux server cannot send WeChat messages');
    }
    await reportProgress({ stage: 'running', message: 'Processing...', percent: 50 });
    return { reply: `Handled on Build Server: ${task.instruction}` };
  },
});

await worker.recoverResults();
await worker.run();
```
