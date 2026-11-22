# AnyLink Protocol v2

[简体中文](README.zh-CN.md) · [OpenAPI 3.1 contract](openapi.json) · [JavaScript/TypeScript SDK](../sdk/README.md)

AnyLink connects applications, agents and devices to shared services without choosing their reasoning engine, UI or operating-system tools. The cloud stores owner facts in three scopes, optionally forwards model requests, and routes tasks between agents. Each host owns execution, approvals and local policy. OpenClaw is one reference implementation; Codex or another application can implement the same host contract.

## Transport and identity

Use HTTPS for remote service access or an authenticated loopback tunnel. Identity is owner → device → agent: one device can host several agents, and routing plus agent-scoped memory isolate at agent level.

`POST /edge/v1/connect` joins with `Authorization: Bearer <join key>` — the owner secret `ANYLINK_JOIN_KEY` kept on the server. The body names the install (`device.install_id`), the device and one agent key; the server upserts both and returns a fresh `ak_` credential plus `protocol.version` `2.0`. Reconnecting with the same install and agent key returns the same IDs and rotates the credential; the previous token stops working immediately. There is no per-pair grant step: any join-key holder can share context and dispatch to any agent. Legacy owner-issued credentials from `/v1/devices/{id}/credential` still work and bind the device's `default` agent.

All other requests use `Authorization: Bearer <agent credential>`. These credentials are revocable per agent; provider keys remain on the server. An agent is a logical identity, not hardware attestation. The reference server is single-owner, not a public multi-tenant service. The join key is powerful: anyone holding it can connect and dispatch to any agent, so keep it in server secrets and serve clients over HTTPS.

`GET /edge/v1/link/protocol` returns protocol `anylink`, version `2.0`, delivery semantics and the routing modes `agent`, `device` and `capability`. This first implementation is a preview. Breaking changes require a new protocol route/version; additive fields may be introduced without replacing the local harness.

## Context, persona and optional models

`GET /edge/v1/context` returns `device_id`, `agent_id`, three memory tiers (`global`, `device`, `agent`, each limited to 30), the configured `persona` document, and a revision-bearing device directory. `GET /edge/v1/persona` returns the persona alone (`404 PERSONA_NOT_CONFIGURED` when unset).

Memory scopes: `global` facts are shared by everyone; `device` facts apply to one device and are visible to all its agents; `agent` facts belong to exactly one agent — other agents on the same device cannot search, read, revise or delete them. Edge callers writing `scope:'agent'` are always bound to their own agent (`403 AGENT_SCOPE_FORBIDDEN` otherwise); owner callers supply `applicable_agent_id` and the device is derived from the agent. Memory mutations use explicit application/user intent, `Idempotency-Key`, and revision preconditions. `PATCH` requires `expected_revision`; `DELETE` requires `If-Match`. Tombstoned facts disappear from current retrieval. This is application memory, not model-weight training.

`POST /model/v1/chat/completions` is optional OpenAI Chat Completions compatible passthrough, including SSE tool-call deltas and `[DONE]`. The reference provider is DeepSeek Flash. It runs no tools or reasoning loop on the cloud. Other harnesses may continue using their own model/authentication.

## Capability and task flow

1. Each agent posts its manifest to `/edge/v1/link/capabilities`, for example `text.reverse` plus a human-readable description. The manifest lives on the agent, not the device.
2. `GET /edge/v1/link/directory` lists every live agent per device with capabilities, `last_seen_at`-based `online` (60 seconds) and a `self` marker. `GET /edge/v1/link/peers` remains as a deprecated per-device compatibility view.
3. The source posts `/edge/v1/link/tasks` with `capability`, `input`, optional `ttl_seconds` (10–86400; default 1800) and an optional `target`: `{agent_id}` routes to exactly that agent, `{device_id}` (or the legacy `target_device_id` field) to any capable agent on that device, and no target lets any capable agent claim it. Resolution requires a live agent advertising the capability and returns `409 NO_TARGET_AGENT` otherwise. The source identity comes from authentication, never from supplied JSON.
4. Any agent calls `/edge/v1/link/tasks/claim`. The server atomically expires stale routable tasks, then claims one queued task whose capability the caller advertises, preferring agent-targeted, then device-targeted, then untargeted work. The source agent must still exist (its credential may have rotated). A null result means no admitted work. Never auto-requeue a running task.
5. The host journals task ID before execution, validates its own input/workspace/permission policy, and runs its registered handler.
6. The claiming agent posts `/edge/v1/link/tasks/{id}/result`; only it can report the result. Source, target and claiming agents can read the task; only the source agent can cancel it.

```json
{
  "target": { "agent_id": "00000000-0000-4000-8000-000000000003" },
  "capability": "text.reverse",
  "input": { "text": "AnyLink" },
  "ttl_seconds": 1800
}
```

Terminal result example:

```json
{"state":"succeeded","output":{"text":"kniLynA"}}
```

States are `queued`, `running`, `cancel_requested`, `succeeded`, `failed`, `cancelled`, `unknown`, `expired`. The source agent may cancel queued work or request cooperative cancellation of running work. A cancellation request does not prove an external operation stopped; a late real success may still be reported. Unknown or interrupted effects must be inspected instead of silently retried. Revoking an agent stops its credentials and makes its agent-targeted queued tasks unclaimable; it does not roll back prior effects.

Input/output objects each have a 64 KiB limit. Lists expose only the newest 100 source/target records; pagination and streamed task events are future work. Task content and results are readable by the server operator.

## Retry contract

Every state-changing request requires a caller-retained idempotency key, scoped to the authenticated agent and operation. Repeating a key with the same body returns its recorded response; changing the body returns 409. Use a fresh key for each new polling claim. Empty claims do not consume persistent keys; only admitted tasks are cached. `connect` and credential issuance are deliberately not idempotency-cached because they return one-time secrets.

The SDK exposes uncertain transport outcomes and does not automatically replay requests or models. Persist a local execution journal. Completed receipts can be re-sent with the original result key. A started journal entry with no result is an unknown outcome, not an instruction to run again. This is at-most-once admission and durable deduplication, not exactly-once external execution.

## Implement another SDK or adapter

The [OpenAPI contract](openapi.json) is generated from server schemas with `npm run protocol:generate`; `npm run protocol:check` detects drift. HTTP callers can implement Kotlin, Swift, Python or other language bindings. The SDK's host interface is simply a capability name and `execute(input, {task, signal})`. UI, avatars, speech recognition and harness-specific session/approval events belong in adapters.

The shipped Android/Mac applications currently authenticate with owner-issued device credentials, which bind each device's `default` agent; they do not yet call `connect`. They are not yet a generic AnyLink mobile controller. The Codex example starts a separate read-only CLI turn; controlling an existing desktop conversation requires a dedicated supported [app-server](https://learn.chatgpt.com/docs/app-server)/session adapter. MCP can expose memory/tools to an agent, but installing an MCP tool alone does not create inbound remote control.

## Device-local reference architecture

Each device connects to the AnyLink server with the join key (or a legacy owner credential) and owns its Agent conversation and tool loop per agent. Android 0.3+ no longer connects to a Mac Gateway. `client.directory()` / `GET /edge/v1/link/directory` discovers live agents and capabilities; `client.peers()` remains for older clients. `last_seen_at` is credential activity, not a worker-online guarantee. Other hosts can implement the same HTTP contract without OpenClaw or the reference UI.
