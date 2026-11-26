# AnyLink Protocol v3 (`3.0`)

[简体中文](README.zh-CN.md) · [OpenAPI 3.1](openapi.json) · [TypeScript SDK](../sdk/README.md) · [Python SDK](../sdk-python/README.md) · [MCP Adapter](../mcp/README.md)

AnyLink is a harness-independent protocol for a **Personal Agent Network**:

- **Edge autonomy**: Each device (macOS, Linux, Windows, Android, servers, scripts) runs its own Agent and manages only its own local environment and security policy.
- **Cloud-centric Model Gateway**: Multi-model OpenAI-compatible passthrough with optional automatic shared-memory injection (`X-AnyLink-Auto-Memory: on`).
- **Cloud Memory Brain**: Unified, cross-device memory managed by a cloud Memory Agent — hybrid CJK/Latin + optional vector retrieval (`POST /edge/v1/memory/assemble`), asynchronous turn/task ingestion (`POST /edge/v1/memory/ingest`), deduplication, conflict consolidation, and automatic **capability boundary learning**.
- **Capability-free cross-device invocation**: Edge agents do not need to inspect rigid capability schemas of remote devices. Send an intent/task directly to a target agent or device; if the receiver cannot execute it, the receiver replies `declined` (or `failed`) with the reason, and the Cloud Memory Brain records that boundary so future turns naturally avoid invalid requests.
- **Real-time WebSocket Bus (`GET /edge/v1/ws`)**: Instant task dispatch, live progress streaming, heartbeats with lease expiry (so crashed workers never hang tasks forever), and instant completion push back to the sender — with full HTTP fallback.

## 1. Identity & Connection

Identity hierarchy: `Owner → Device → Agent`.

1. **Join (`POST /edge/v1/connect`)**: Authenticate with `Authorization: Bearer <ANYLINK_JOIN_KEY>`, supply `device: { install_id, name, platform, slug? }` and `agent: { key, name, kind?, summary? }`. `slug` is a unique short alias (e.g. `home-mac`, `gpu-box`; auto-generated if omitted) to disambiguate devices with identical display names. Returns `201` with `device_id`, `device_slug`, `agent_id`, `credential_id`, one-time `token` (`ak_...`), and `protocol: { name: "anylink", version: "3.0" }`.
2. **Protocol negotiation (`GET /edge/v1/protocol`, alias `GET /edge/v1/link/protocol`)**: Returns version `3.0`, transport URLs, lease-backed at-most-once delivery semantics, and routing modes (`agent`, `device`, `device_slug`, `device_name`, `agent_key`, `any`).
3. **Profile (`PATCH /edge/v1/agent/profile`, `PATCH /edge/v1/device/profile`)**: Update informational agent summary or device name / unique `slug`. Informational only; never blocks incoming tasks.

## 2. Cloud Memory Brain

### Scopes & Kinds
- **Scopes**: `global` (shared across all devices), `device` (scoped to one device; only that device or Owner may mutate it), `agent` (private to one agent).
- **Kinds**: `fact`, `preference`, `boundary` (learned limits of what a device/agent can or cannot do), `episode`.

### Endpoints
- **`POST /edge/v1/memory/assemble`**: Given `{ query?, max_memories?, max_episodes?, max_chars?, include_scopes?, include_boundaries?, include_persona? }`, returns ranked `memories`, recent cross-device `episodes`, cross-device `boundaries`, and a ready-to-inject `summary_text`.
- **`POST /edge/v1/memory/ingest`**: Submit `{ kind: "turn" | "task_outcome" | "observation", session_key?, messages, metadata?, consolidate_now? }`. Automatically skips trivial short chitchat (0 LLM tokens), debounces & batches burst turns per session (`ANYLINK_MEMORY_DEBOUNCE_MS=15000`, `ANYLINK_MEMORY_BATCH_MAX=6`) into a single Cloud Memory Agent LLM call, and immediately consolidates declined/failed task outcomes so device boundaries are learned without delay.
- **`GET /edge/v1/memory/episodes`**: List recent cross-device episodes.
- **`GET /edge/v1/context`**: Snapshot returning `global`, `device`, `agent` memories, `boundaries`, `episodes`, and optional `persona`.
- **Explicit CRUD**: `POST /edge/v1/memories`, `POST /edge/v1/memories/search`, `GET /edge/v1/memories/:id`, `PATCH /edge/v1/memories/:id` (CAS via `expected_revision`), `DELETE /edge/v1/memories/:id` (CAS via `If-Match`).

## 3. Multi-Model Gateway

- **`GET /model/v1/models`**: Lists configured models and aliases (`default`, provider models, etc.).
- **`POST /model/v1/chat/completions`**: OpenAI-compatible JSON & SSE streaming passthrough supporting multiple configured models/providers and per-agent concurrency limits (agents on the same device no longer deadlock each other).
  - **Optional Auto-Memory Mode**: Pass `X-AnyLink-Auto-Memory: on` (or enable `ANYLINK_AUTO_MEMORY_DEFAULT=true` on the server) to automatically assemble relevant shared memory into the request context and ingest the completed turn into the Cloud Memory Brain in the background.
- **`POST /model/v1/speech`**: Optional TTS endpoint. Style/prompt is caller- or deployment-configurable (neutral by default, decoupled from any showcase character).

## 4. Cross-Device Invocation & WebSocket Bus

### Task States
`queued` → `running` (with `lease_expires_at`) → `succeeded` | `failed` | `declined` | `cancelled` | `unknown` | `expired` (plus `cancel_requested` during cooperative cancellation).

- **Create (`POST /edge/v1/tasks`, alias `POST /edge/v1/link/tasks`)**:
  ```json
  {
    "target": { "device_name": "Mac" },
    "instruction": "Move report.md from Desktop to Projects",
    "ttl_seconds": 1800,
    "lease_seconds": 120
  }
  ```
  `target` supports `{ agent_id }`, `{ device_id }`, `{ device_slug }` (unambiguous unique short alias), `{ device_name }` (returns `409 AMBIGUOUS_TARGET_DEVICE` with candidate slugs if duplicate names exist), `{ agent_key }`, or omitted (`any`). `capability` is optional (defaults to `"agent.invoke"`). The server never rejects a task for missing capability declarations; the receiving agent decides locally and may return `state: "declined"` with `error: { code, message }` — which the Cloud Memory Brain automatically records as a `boundary` memory.
- **Claim, Heartbeat, Progress, Result, Cancel**:
  - HTTP fallback: `POST /edge/v1/tasks/claim`, `POST /edge/v1/tasks/:id/heartbeat`, `POST /edge/v1/tasks/:id/progress`, `POST /edge/v1/tasks/:id/result`, `POST /edge/v1/tasks/:id/cancel` (all `/edge/v1/link/tasks*` aliases remain supported).
  - **Lease expiration**: If a running worker crashes and fails to heartbeat before `lease_expires_at`, the server transitions the task to `unknown` (`LEASE_EXPIRED`) and notifies the sender, never silently re-running side effects.

### WebSocket Frame Schema (`GET /edge/v1/ws`)
Connect with `Authorization: Bearer <token>` (or send `{ "type": "auth", "token": "<token>" }` as the first frame within 5s).

- **Server → Edge**:
  - `hello`: `{ type: "hello", protocol: "3.0", agent_id, device_id, server_time }`
  - `pong`: `{ type: "pong", ts }`
  - `task.available`: `{ type: "task.available", task_id, target_agent_id, target_device_id, capability, instruction }`
  - `task.claimed`: `{ type: "task.claimed", request_id?, task }`
  - `task.ack`: `{ type: "task.ack", request_id?, task_id, ok, task? }`
  - `task.progress`: `{ type: "task.progress", task_id, progress }` (pushed live to sender)
  - `task.completed`: `{ type: "task.completed", task }` (pushed live to sender)
  - `task.cancel`: `{ type: "task.cancel", task_id }` (pushed live to claimer)
  - `memory.updated`: `{ type: "memory.updated", episode_id, actions }`
  - `error`: `{ type: "error", request_id?, code, message }`
- **Edge → Server**:
  - `ping`: `{ type: "ping", ts? }`
  - `task.claim`: `{ type: "task.claim", request_id?, idempotency_key, task_id? }`
  - `task.heartbeat`: `{ type: "task.heartbeat", request_id?, task_id, extend_seconds? }`
  - `task.progress`: `{ type: "task.progress", request_id?, task_id, progress }`
  - `task.result`: `{ type: "task.result", request_id?, task_id, idempotency_key, result }`
  - `task.cancel`: `{ type: "task.cancel", request_id?, task_id, idempotency_key }`

## 5. Idempotency & Crash Recovery

All state-changing writes require `Idempotency-Key` (replaying same key + same canonical body returns the cached result; different body returns `409 IDEMPOTENCY_CONFLICT`). Workers must persist a local execution journal before invoking a handler: completed results are safely re-sent with `result:<task_id>`, while `started`-only entries after a crash report `unknown` rather than blindly repeating external side effects.
