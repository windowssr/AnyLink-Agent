# AnyLink Protocol v1

[简体中文](README.zh-CN.md) · [OpenAPI 3.1 contract](openapi.json) · [JavaScript/TypeScript SDK](../sdk/README.md)

AnyLink connects applications, agents and devices to shared services without choosing their reasoning engine, UI or operating-system tools. The cloud stores owner facts, optionally forwards model requests, and relays granted tasks. Each target host owns execution and approvals. OpenClaw is one reference implementation; Codex or another application can implement the same host contract.

## Transport and identity

Use HTTPS for remote service access or an authenticated loopback tunnel. Requests use JSON and `Authorization: Bearer <device credential>`. These credentials are issued once by the owner through `/v1/devices/{id}/credential`; provider keys remain on the server. A device is a logical identity, not hardware attestation. The reference server is single-owner, not a public multi-tenant service.

`GET /edge/v1/link/protocol` returns protocol `anylink`, version `1.0`, and supported surfaces. This first implementation is a preview. Breaking changes require a new protocol route/version; additive fields may be introduced without replacing the local harness.

## Context and optional models

`GET /edge/v1/context` returns `device_id`, `global`, `device`, and a revision-bearing device directory. Memory mutations use explicit application/user intent, `Idempotency-Key`, and revision preconditions. `PATCH` requires `expected_revision`; `DELETE` requires `If-Match`. Tombstoned facts disappear from current retrieval. This is application memory, not model-weight training.

Default context selects global and own-device facts. The legacy memory endpoints allow explicit cross-device reads/writes within the same owner's trust domain. Do not represent this as strict device-level data isolation.

`POST /model/v1/chat/completions` is optional OpenAI Chat Completions compatible passthrough, including SSE tool-call deltas and `[DONE]`. The reference provider is DeepSeek Flash. It runs no tools or reasoning loop on the cloud. Other harnesses may continue using their own model/authentication.

## Host capability and task flow

1. The target posts its manifest to `/edge/v1/link/capabilities`, for example `text.reverse` plus a human-readable description.
2. The owner enables a source/target/capability tuple at `/v1/link/grants`. Registration alone grants nothing.
3. The source posts `/edge/v1/link/tasks` with `target_device_id`, `capability`, `input`, and optional `ttl_seconds` (10–86400; default 1800). The source ID comes from authentication, never from supplied JSON.
4. The target calls `/edge/v1/link/tasks/claim`. The server atomically checks current grants, advertised capability and source credential, and claims one queued task. A null result means no admitted work. Never auto-requeue a running task.
5. The host journals task ID before execution, validates its own input/workspace/permission policy, and runs its registered handler.
6. The target posts `/edge/v1/link/tasks/{id}/result`. Only that target can report the result. The source polls the task and displays its actual receipt.

```json
{
  "target_device_id": "00000000-0000-4000-8000-000000000002",
  "capability": "text.reverse",
  "input": { "text": "AnyLink" },
  "ttl_seconds": 1800
}
```

Terminal result example:

```json
{"state":"succeeded","output":{"text":"kniLynA"}}
```

States are `queued`, `running`, `cancel_requested`, `succeeded`, `failed`, `cancelled`, `unknown`, `expired`. The source may cancel queued work or request cooperative cancellation of running work. A cancellation request does not prove an external operation stopped; a late real success may still be reported. Unknown or interrupted effects must be inspected instead of silently retried. Revocation stops later admission and does not roll back prior effects.

Input/output objects each have a 64 KiB limit. Lists expose only the newest 100 source/target records; pagination and streamed task events are future work. Task content and results are readable by the server operator.

## Retry contract

Every state-changing request requires a caller-retained idempotency key. Scope includes the authenticated device and operation. Repeating a key with the same body returns its recorded response; changing the body returns 409. Use a fresh key for each new polling claim. Empty claims do not consume persistent keys; only admitted tasks are cached.

The SDK exposes uncertain transport outcomes and does not automatically replay requests or models. Persist a local execution journal. Completed receipts can be re-sent with the original result key. A started journal entry with no result is an unknown outcome, not an instruction to run again. This is at-most-once admission and durable deduplication, not exactly-once external execution.

## Implement another SDK or adapter

The [OpenAPI contract](openapi.json) is generated from server schemas with `npm run protocol:generate`; `npm run protocol:check` detects drift. HTTP callers can implement Kotlin, Swift, Python or other language bindings. The SDK's host interface is simply a capability name and `execute(input, {task, signal})`. UI, avatars, speech recognition and harness-specific session/approval events belong in adapters.

The shipped Android/Mac applications currently use the OpenClaw reference transport. They are not yet a generic AnyLink mobile controller. The Codex example starts a separate read-only CLI turn; controlling an existing desktop conversation requires a dedicated supported [app-server](https://learn.chatgpt.com/docs/app-server)/session adapter. MCP can expose memory/tools to an agent, but installing an MCP tool alone does not create inbound remote control.
