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

```js
import { AnyLinkClient } from '@anylink-agent/sdk';

const link = new AnyLinkClient({
  baseUrl: process.env.ANYLINK_BASE_URL,
  token: process.env.ANYLINK_DEVICE_TOKEN,
});
const context = await link.context(); // global + this logical device

// Store only when your application has explicit user intent/authority.
const fact = await link.saveMemory({
  title: 'Preferred language', content: 'Chinese', scope: 'global',
}, { idempotencyKey: crypto.randomUUID() });
await link.updateMemory(fact.id, fact.revision, { content: 'Chinese and English' });
```

Register a logical device in the self-hosted owner console and securely save its one-time credential. Do not use the owner token as a device token. The reference service is single-owner: device identities share an owner trust domain, rather than providing multi-tenant isolation.

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

After the target has advertised its capabilities, the owner grants a source device permission to use a specific target capability:

```bash
node scripts/grant-capability.mjs \
  --server http://127.0.0.1:3180 \
  --owner-token-file secrets/local-dev-owner-token \
  --source SOURCE_DEVICE_UUID --target TARGET_DEVICE_UUID \
  --capability text.reverse
```

This command belongs to the reference server checkout. Add `--revoke` to stop future admission. A sender can then create and poll a task:

```js
const task = await link.createTask({
  target_device_id: targetDeviceId,
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
- Task admission is at most once. The server never automatically requeues running work. The local journal prevents replay of an admitted handler; keep one journal for each service/device identity. The SDK binds it before sending receipts.
- Saved completed results can be resent. A durable `started` receipt without a result is an unknown external outcome: inspect the host and settle it explicitly. It is not safe to promise exactly-once external effects.
- Cancellation is cooperative. Interrupted handlers report `unknown` unless the host can prove cancellation. Register your own host-specific policy checks before side effects.
- Task input/output objects are limited to 64 KiB. Task lists return the newest 100 records; pagination and streaming task events are not yet implemented.

The [read-only Codex adapter](examples/codex-read-only.mjs) demonstrates one host handler. It starts a separate CLI turn in an operator-selected workspace; it does not control an existing Codex desktop chat. The [Mac OpenClaw integration](../mac/plugin) is the richer reference implementation, not a dependency of this SDK.

One logical device has one capability manifest. Parallel workers for the same identity must share their journal and handler set. The Codex example uses a filesystem read-only sandbox; MCP/plugin/connector policy remains operator configured.

A handler exception can occur after an external effect completed. The worker therefore reports unknown by default; an exception is not proof that retrying is safe.

## Device-local reference architecture

Each device connects to the AnyLink server and owns its Agent conversation and tool loop. Android 0.3+ no longer connects to a Mac Gateway. `client.peers()` / `GET /edge/v1/link/peers` discovers only targets and capabilities granted to the authenticated source; `last_seen_at` is credential activity, not a worker-online guarantee. Other hosts can implement the same HTTP contract without OpenClaw or the reference UI.
