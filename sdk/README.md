# AnyLink SDK

[简体中文](README.zh-CN.md) · [Protocol](../protocol/README.md)

A dependency-free JavaScript/TypeScript client for AnyLink memory, model passthrough and device tasks. It does not require OpenClaw, Codex, an avatar or an agent framework. The optional Node worker uses the built-in SQLite module for durable execution receipts. Use Node 24; Node 22.13+ is the minimum.

## Install

```bash
npm install https://github.com/windowssr/AnyLink-Agent/releases/download/v0.8.1-preview.1/anylink-agent-sdk-0.1.1.tgz
# From a checkout instead:
npm install ./sdk
```

The package is distributed as a release tarball; it has not been published to the npm registry.

## Connect your application

Devices join with the owner **join key** (`ANYLINK_JOIN_KEY` on the server). `connect()` upserts the install's device and agent and returns a fresh credential; reconnecting with the same install and agent key rotates the token safely. Any join-key holder can immediately share context and dispatch to any agent — there is no grant step. Keep the join key in server secrets and serve clients over HTTPS.

```js
import { AnyLinkClient } from '@anylink-agent/sdk';

const joined = await AnyLinkClient.connect({
  baseUrl: process.env.ANYLINK_BASE_URL,
  joinKey: process.env.ANYLINK_JOIN_KEY,
  installId: process.env.ANYLINK_INSTALL_ID,
  device: { name: 'Build server', platform: 'other' },
  agent: { key: 'builder', name: 'Build agent' },
});
const link = new AnyLinkClient({ baseUrl: process.env.ANYLINK_BASE_URL, token: joined.token });
const context = await link.context(); // global + device + own-agent tiers + persona

// Or reuse a saved credential issued earlier by connect or the owner console:
// const link = new AnyLinkClient({ baseUrl: process.env.ANYLINK_BASE_URL, token: process.env.ANYLINK_DEVICE_TOKEN });

// Store only when your application has explicit user intent/authority.
const fact = await link.saveMemory({
  title: 'Preferred language', content: 'Chinese', scope: 'global',
}, { idempotencyKey: crypto.randomUUID() });
await link.updateMemory(fact.id, fact.revision, { content: 'Chinese and English' });
```

A device can host several agents: each agent has its own key, capabilities, tasks and agent-scoped memories. Legacy owner-issued credentials still work and bind the device's `default` agent. The reference service is single-owner: device identities share an owner trust domain, rather than providing multi-tenant isolation.

## Receive work in your project

Create a private state directory first and exclude it from version control. Keep its journal across restarts.

```js
import { AnyLinkWorker } from '@anylink-agent/sdk/worker';

const worker = new AnyLinkWorker({
  client: link,
  journalPath: './private-state/receipts.sqlite',
  handlers: {
    'text.reverse': {
      description: 'Reverse supplied text without accessing the computer',
      async execute(input, { signal, task }) {
        signal.throwIfAborted();
        if (typeof input.text !== 'string') throw new Error('Invalid text');
        return { text: [...input.text].reverse().join('') };
      },
    },
  },
});
await worker.recoverResults(); // resend saved receipts, never rerun handlers
await worker.run({ signal: shutdownSignal });
```

`shutdownSignal` is your application's AbortSignal. For a complete runnable program with signal handling and directory creation, see [examples/worker.mjs](examples/worker.mjs).

After the worker has advertised its capabilities, any agent can dispatch work to it — target a specific agent, a whole device, or leave the target open and let any capable agent claim:

```js
const directory = await link.directory(); // live agents per device
const task = await link.createTask({
  target: { agent_id: targetAgentId }, // or { device_id } or omit target
  capability: 'text.reverse',
  input: { text: 'AnyLink' },
}, { idempotencyKey: crypto.randomUUID() });
const current = await link.task(task.id);
// queued -> running -> succeeded / failed / unknown
// current.result contains the executor's real output once reported.
```

The host owns execution and authorization. AnyLink does not interpret a prompt as permission to run arbitrary shell commands. Register narrowly scoped handlers and validate inputs and workspace/application access in each handler.

## Optional model passthrough

```js
for await (const event of link.streamChatCompletions({
  model: 'deepseek-flash',
  messages: [{ role: 'user', content: 'Hello' }],
})) {
  // Tool call deltas, text deltas and usage remain available as received.
  consume(event);
}
```

The current reference server supports DeepSeek Flash. This is an optional SDK surface, not a requirement to replace your harness's model configuration. In particular, the Codex CLI example uses Codex's own authentication and model settings.

## Failure and recovery

- No automatic HTTP/model replay. `AnyLinkError` exposes `code`, `status`, `requestId`, `idempotencyKey` and `submissionUnknown`.
- Reuse the same mutation key to reconcile a lost response; use a new key for each new claim/poll. Empty claims do not consume a persistent key; only admitted tasks are cached.
- Task admission is at most once. The server never automatically requeues running work. The local journal binds the service, device and agent identity and prevents replay of an admitted handler; keep one journal for each service/device/agent identity. The SDK binds it before sending receipts.
- Saved completed results can be resent. A durable `started` receipt without a result is an unknown external outcome: inspect the host and settle it explicitly. It is not safe to promise exactly-once external effects.
- Cancellation is cooperative. Interrupted handlers report `unknown` unless the host can prove cancellation. Register your own host-specific policy checks before side effects.
- Task input/output objects are limited to 64 KiB. Task lists return the newest 100 records; pagination and streaming task events are not yet implemented.

The [read-only Codex adapter](examples/codex-read-only.mjs) demonstrates one host handler. It starts a separate CLI turn in an operator-selected workspace; it does not control an existing Codex desktop chat. The [Mac OpenClaw integration](../mac/plugin) is the richer reference implementation, not a dependency of this SDK.

One logical device has one capability manifest. Parallel workers for the same identity must share their journal and handler set. The Codex example uses a filesystem read-only sandbox; MCP/plugin/connector policy remains operator configured.

A handler exception can occur after an external effect completed. The worker therefore reports unknown by default; an exception is not proof that retrying is safe.

## Device-local reference architecture

Each device connects to the AnyLink server and owns its Agent conversation and tool loop. Android 0.3+ no longer connects to a Mac Gateway. `client.directory()` / `GET /edge/v1/link/directory` discovers live agents, capabilities and presence per device; `client.peers()` / `GET /edge/v1/link/peers` remains as a deprecated device-level view; `last_seen_at` is credential activity, not a worker-online guarantee. Other hosts can implement the same HTTP contract without OpenClaw or the reference UI.
