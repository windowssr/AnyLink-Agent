<p align="center"><img src="docs/assets/banner.svg" alt="AnyLink Agent — protocol and SDK" width="100%"></p>

<p align="center"><a href="README.zh-CN.md">简体中文</a> · <a href="protocol/README.md">Protocol v3</a> · <a href="sdk-python/README.md">Python SDK (PyPI)</a> · <a href="sdk/README.md">TypeScript SDK (npm)</a> · <a href="mcp/README.md">MCP Server</a> · <a href="LICENSE">MIT</a></p>

# AnyLink Agent

**Personal Agent Network — Edge autonomy, Cloud Memory Brain, Multi-Model Gateway, and real-time WebSocket invocation.**

AnyLink (`Protocol v3`) lets you run autonomous agents across your computers, servers, and phone while keeping **shared memory** and **LLM API calls** centralized on your own cloud hub:

- **Cloud Memory Brain (`POST /edge/v1/memory/assemble`, `POST /edge/v1/memory/ingest`)**: Hybrid CJK/Latin + optional vector retrieval, asynchronous LLM-driven extraction/deduplication/consolidation, cross-device episodic summaries, and **automatic device capability boundary learning**.
- **Multi-Model Gateway (`POST /model/v1/chat/completions`)**: OpenAI-compatible multi-provider/multi-model routing with per-agent concurrency control and optional **Auto-Memory Mode** (`X-AnyLink-Auto-Memory: on`).
- **Capability-free Cross-Device Invocation + WebSocket Bus (`GET /edge/v1/ws`)**: Edge agents manage only their own local environment and never need rigid remote capability tables. Send an instruction to any device/agent; if the receiver cannot handle it, it returns `declined` with the reason, and the Cloud Memory Brain automatically learns that boundary for future turns. Live progress, lease heartbeats, and instant completion push run over WebSocket with HTTP fallback.
- **Open-Source Packaging**:
  - **Python SDK (`sdk-python/`, PyPI `anylink-agent`)**: async client + `@agent.on_invoke` WebSocket worker + crash-safe JSONL journal.
  - **TypeScript SDK (`sdk/`, npm `@anylink-agent/sdk`)**: zero-dependency Node 22+ client, WebSocket socket, and durable `FileJournal` worker.
  - **MCP Server (`mcp/`, `@anylink-agent/mcp`)**: zero-code stdio bridge for Claude Code, Cursor, Codex, and OpenClaw.
- **Reference Showcase Clients ("蓝色大肥鱼")**: Mac OpenClaw desktop/companion integration and native Android companion app (migration to Protocol v3 tracked in Phase 2).

<img src="docs/assets/architecture.svg" alt="Applications connect through the AnyLink SDK to cloud services and host-owned execution" width="100%">

**Android 0.3+ connects only to the AnyLink server, never to a Mac Gateway.** With the Mac offline, phone chat, phone tools and shared memory keep working. Mac-directed work is queued and returned through the server. Android 0.2.x was a historical companion preview; that connection path is retired. The Codex example still starts a separate read-only CLI turn and does not control an existing desktop chat.

## Downloads

The first public release is **v0.8.1-preview.1**. [GitHub Releases](https://github.com/windowssr/AnyLink-Agent/releases/tag/v0.8.1-preview.1) contains binaries, source revision, a manifest and SHA-256 checksums:

- [Android APK](https://github.com/windowssr/AnyLink-Agent/releases/download/v0.8.1-preview.1/AnyLink-Android-0.3.0-preview.1.apk): Android 12+, debug-signed preview.
- [Mac application](https://github.com/windowssr/AnyLink-Agent/releases/download/v0.8.1-preview.1/AnyLink-macOS-arm64-0.8.1-preview.zip): Apple Silicon, macOS 15+. This compiled desktop shell uses a separately configured checkout; select your own project directory at first launch. Voice input requires macOS 26. The preview is ad-hoc signed and not notarized; see [client setup](docs/open-source/clients.md).
- [SDK tarball](https://github.com/windowssr/AnyLink-Agent/releases/download/v0.8.1-preview.1/anylink-agent-sdk-0.1.1.tgz): install in your own Node/TypeScript project. Not yet published to the npm registry.

Public packages **exclude the DeepSeek-chan model, textures, derived avatar and Live2D Cubism Core**. They use original code-drawn placeholder artwork. Obtain optional third-party assets through their authors and follow their licenses; the MIT code license does not grant character/model redistribution rights.

## Connect a phone

In the app's **Server connection** panel, enter your **AnyLink HTTPS URL** and the owner **join key** (optionally a device name). From 0.4.0-preview.1 the phone joins as the `android-dafeiyu` agent; the join key is used only for that request and never stored. A legacy one-time credential JSON can still be imported for older setups, and a stored legacy credential adopts the new install ID so device memories carry over. No Mac address, OpenClaw token or pairing is needed. The server provides model inference; the phone runs its own tool loop. A reachable HTTPS endpoint is an operator deployment prerequisite; USB/SSH forwarding is only a development option. See [phone connection and domainless HTTPS](docs/open-source/phone-connection.md) and [client setup](docs/open-source/clients.md).

## Preview

<p><img src="docs/assets/android-public.jpg" alt="Public placeholder artwork in the desktop browser preview" width="45%"> <img src="docs/assets/android-optional-character.jpg" alt="An optional third-party character configured locally; not bundled" width="45%"></p>

Left: public placeholder. Right: optional third-party character configured locally. Both images are **desktop browser composition previews, not Android hardware screenshots**. DeepSeek-chan / 大肥鱼 art and separation: **神宫凉子**; Live2D: **霓虹猫_NeonNeko**. [Model source and usage notice](https://github.com/YJackie-Li/DeepSeek-chan/blob/main/README.md).

Native server-connection screen rendered by the Android UI test (not a physical-phone screenshot):

<img src="docs/assets/android-server-connection.png" alt="Android AnyLink server connection" width="300">

## Connect your project

```bash
npm install https://github.com/windowssr/AnyLink-Agent/releases/download/v0.8.1-preview.1/anylink-agent-sdk-0.1.1.tgz
```

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
const context = await link.context();
const task = await link.createTask({
  target: { agent_id: targetAgentId },
  capability: 'text.reverse',
  input: { text: 'AnyLink' },
}, { idempotencyKey: crypto.randomUUID() });
```

One join key connects any device and agent — no per-pair grants. See the [SDK guide](sdk/README.md) for a runnable worker, agent routing, receipt recovery and optional model streaming. If you only need shared memory, use the context/memory methods without replacing your harness or provider.

## Self-host the reference service

Requirements: Node 24, npm and Docker Compose. A provider key is needed only for optional model passthrough.

```bash
git clone https://github.com/windowssr/AnyLink-Agent.git
cd AnyLink-Agent
npm ci
node scripts/init-local.mjs
# Optional model passthrough: configure DEEPSEEK_API_KEY in .env. Never commit .env.
docker compose --env-file .env -f deploy/compose.local.yaml up -d --wait
npm run build
node --env-file=.env dist/server/index.js
```

Open `http://127.0.0.1:3180`. Log in using the owner token in `secrets/local-dev-owner-token`. `init-local.mjs` also writes `secrets/local-dev-join-key`; devices join through `AnyLinkClient.connect` or `POST /edge/v1/connect`. The owner console under **设备访问** lists devices and their agents for inspection and revocation, and can still issue legacy one-time credentials bound to a device's `default` agent. Owner, join, device and model-provider credentials are separate.

The default is loopback-only. Use HTTPS or an SSH tunnel for remote access. Deployment and rollback tooling lives in `deploy/` and `scripts/`; read [self-hosting](docs/open-source/self-hosting.md) before production use.

## Development and examples

```bash
npm run check
npm run test:sdk
npm run protocol:check
npm run build
# Disposable anylink_test only: this suite rebuilds its schema.
TEST_DATABASE_URL=postgresql://USER:PASS@127.0.0.1:5432/anylink_test npm run test:integration
```

- [Protocol and OpenAPI](protocol/README.md): HTTP, identity, capabilities, states, idempotency and recovery.
- [SDK](sdk/README.md): host workers, memory and streaming model methods.
- [Read-only Codex example](sdk/examples/codex-read-only.mjs): an operator-selected workspace, without approval bypass.
- [Mac and Android reference clients](docs/open-source/clients.md): setup, permissions, connectivity and optional characters.
- [Product design archive](docs/product/README.md): earlier exploration and interaction design, not a claim that every planned feature has shipped.

## Current boundaries

This is a **single-owner reference deployment**. Logical devices share one owner trust domain. Default context selection is not multi-tenant data isolation or proof of physical pairing. The join key lets any holder connect and dispatch to any agent; the real execution boundary is each host's local policy. Cancellation is cooperative; exactly-once effects in external systems cannot be guaranteed. The server can read stored memory/tasks and forwarded model content.

The native Android Agent speaks the generic cloud protocol; a standalone Kotlin SDK is not published. Current phone tools cover device information, private notes, shared memory and cross-device tasks; general control of other apps is not implemented. Existing Codex desktop-chat control and end-to-end realtime voice are not implemented. Phone speech, GPU and lifecycle behavior still require hardware verification. See [SECURITY](SECURITY.md).

## License and mirrors

Original code and documentation are [MIT licensed](LICENSE). Third-party code/assets retain their own terms; see [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md).

[GitHub](https://github.com/windowssr/AnyLink-Agent) and [Gitee](https://gitee.com/windowssr/anylink-agent) share the same `main` and version tags. Binary assets live on GitHub Releases, linked from both mirrors. Maintainers run `npm run repo:sync` after reconciling divergent remote changes; the script never force-pushes. Contributions and host adapters are welcome: [CONTRIBUTING](CONTRIBUTING.md).
