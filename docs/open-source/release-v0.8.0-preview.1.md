# AnyLink v0.8.0-preview.1

AnyLink is now published as a harness-independent protocol and SDK, with OpenClaw-based reference clients.

- Protocol v1 / OpenAPI 3.1: shared context, optional model passthrough and explicitly granted device tasks.
- SDK 0.1.0: JavaScript/TypeScript client plus Node worker with service/device-bound SQLite receipts, no automatic unknown-outcome execution replay, and recovery of durable results.
- Reference service 0.4.0: additive task-relay migration; model provider configuration is optional.
- macOS reference 0.8.0: Apple Silicon, macOS 15+, compiled desktop shell for your own configured checkout, ad-hoc signed and not notarized.
- Android reference 0.2.0-preview.2: Android 12+, debug signed, original placeholder artwork, official OpenClaw Chat/Talk and node lifecycle.

Public binaries contain no DeepSeek-chan model, textures, derived avatar or Cubism Core. Obtain optional resources from their authors for permitted local use. The MIT license covers original code, not third-party characters or proprietary runtimes.

Validation: server/SDK real-HTTP integration, grant/revocation boundaries, concurrent claim, lost result response recovery, restart behavior, package import/types, public Android JVM regressions and binary inspection. See repository documents and the release manifest for exact source and checksums.

The native applications still use OpenClaw transport. A generic phone-controller layer and control of existing Codex desktop conversations are not shipped. The Codex example starts a separate filesystem-read-only CLI turn; connector/approval policy remains the operator's responsibility. Android microphone/playback/interruption/GPU/background/node operations still require physical-device testing.

---

AnyLink 首次以通用接入协议和 SDK 的定位公开，OpenClaw 改版作为参考客户端。

- 协议／OpenAPI：统一上下文、可选模型代理、主人显式授权的设备任务。
- SDK：可直接安装到自己的项目，宿主注册能力后领取任务、本机执行、回传持久结果；未知操作不会自动重跑。
- 服务端：新增任务中继表，不运行 Agent 工具循环，没有模型 Key 也能使用记忆和任务。
- Mac／Android：提供已编译参考软件；公开包使用原创占位形象，不携带大肥鱼模型、纹理、派生头像或 Cubism Core。

Mac 包需要选择自己已配置的工程；Android 包使用 OpenClaw 连接方式，并非通用手机控制器。手机语音、GPU 和节点操作仍待真机验收。Codex 示例创建独立 CLI 只读任务，不控制已有桌面聊天。

源码与版本标签同时维护于 GitHub／Gitee，公开资源统一存放于本 Release。请核对 SHA256SUMS，查看安装说明、第三方素材许可及当前边界。
