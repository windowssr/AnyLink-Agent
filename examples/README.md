# Reference Showcase Clients (`examples/`)

AnyLink's core is the **client-agnostic Protocol v3.2**, Cloud Hub (`server/`), TypeScript SDK (`sdk/`), Python SDK (`sdk-python/`), and MCP Server (`mcp/`). You do **not** need anything in `examples/` to build your own personal Agent network.

This directory isolates our two ready-to-use reference showcase clients (featuring the optional "DaFeiYu / 大肥鱼" companion persona) cleanly from the core protocol and server code:

| Directory | Showcase Client | Highlights | Setup Guide |
| :--- | :--- | :--- | :--- |
| [`examples/mac-openclaw/`](mac-openclaw/) | **Mac Desktop Agent (OpenClaw + Worker + Desktop Companion)** | Background macOS LaunchAgent, Protocol v3.2 memory & `anylink_invoke` / `anylink_task_reply`, concurrent WS worker (`maxConcurrency=2`), sandboxed or opt-in `--full-access` with stale-boundary self-healing, optional Live2D desktop companion | [Mac Setup Guide](mac-openclaw/README.md) |
| [`examples/android-native/`](android-native/) | **Android Native Independent Agent** | Standalone on-device Agent (works even when Mac is offline), Deep-Sea Glass full-bleed Live2D stage with WebGL pixel verification, Companion/Reading toggle, v3.2 approval/choice cards, quick password login, WS resume/ACK, detached SSE resume, offline SQLite outbox, persona TTS | [Android Setup Guide](android-native/README.md) |
| [`examples/persona/`](persona/) | **Optional Mascot Persona Template** | Shared persona baseline (`dafeiyu.md`); completely optional — set `ANYLINK_PERSONA_FILE=""` on the server to run 100% neutral | [dafeiyu.md](persona/dafeiyu.md) |

> **Isolation Principle**: Core protocol specs (`protocol/`), cloud services (`server/`), SDKs (`sdk/`, `sdk-python/`), and MCP (`mcp/`) have zero dependency on OpenClaw, macOS, Android, or any third-party Live2D assets.
