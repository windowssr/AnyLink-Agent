# AnyLink v0.8.1-preview.1

Each device now owns its Agent and connects to the AnyLink server. Android 0.3.0-preview.1 replaces the historical Mac-Gateway companion with a native local conversation and tool loop. The Mac can be offline while the phone chats and uses local tools; only Mac-directed tasks wait in the cloud queue.

- Android server URL + device credential import, identity verification, Keystore encryption and SQLite receipts.
- Phone tools: device information, private notes, shared memory, expressions and granted cross-device tasks. The old Gateway phone-node features are not claimed by this cutover.
- SDK 0.1.1 / service 0.4.1: granted peer discovery and Mac `files.search` cloud worker, with local root policy and durable execution receipts.
- Mac 0.8.1: existing local OpenClaw interaction; starts the independent cloud worker when configured.
- Generic protocol/SDK remains harness-independent. Codex example starts a separate read-only CLI task, not an existing desktop chat.

Install Android 12+ and enter your own reachable AnyLink HTTPS endpoint and the phone's own credential JSON. No Mac Gateway pairing is needed. The production reference remains loopback-only until the operator provides a protected HTTPS entrance. USB/SSH forwarding is a development option, not the final phone dependency.

Public binaries exclude third-party character/model/Core resources and use original placeholder artwork. Android is debug signed; Apple Silicon Mac archive is ad-hoc signed and not notarized, and uses a separately configured checkout. Verify SHA256SUMS and release-manifest.json. Physical phone speech, GPU and lifecycle behavior remain unverified; no full-duplex/latency promise.

Local validation: 12 native Agent/UI tests, 28 server/HTTP integration tests, 18 SDK/Mac-search tests and 7 portable-setup tests passed. TypeScript, protocol generation and source credential audits passed. These do not replace physical-phone verification.

---

本次修正为：**设备各自运行 Agent，全部连接 AnyLink 服务器**。Android 0.3.0-preview.1 不再连接 Mac Gateway，手机自行管理会话、流式回复、工具和结果。Mac 关机不影响手机聊天与本机工具；只有发给 Mac 的任务等待。

手机连接页导入服务器签发的独立设备凭据，验证后通过 Keystore 加密保存；执行记录和便笺存在私有 SQLite。当前工具包括基础状态、私有便笺、统一记忆、表情、跨设备任务。SDK0.1.1／服务0.4.1新增已授权目标发现；Mac0.8.1以独立 Worker 领取 `files.search`，按本机只读策略返回真实回执。

公开包无第三方人物模型、纹理、派生头像或 Cubism Core。Android 使用开发签名，Mac 未公证且需要自行配置工程。正式远程使用要有自己的 HTTPS 入口，USB／SSH 为开发调试通道。系统语音与 GPU 尚待真机验收，不承诺 Grok 延迟或自动开口打断。通用手机 App 操控和 Codex 现有桌面聊天控制不在此版能力中。

本机已通过 12 项原生 Agent／界面测试、28 项服务端与 HTTP 集成测试、18 项 SDK／Mac 搜索测试、7 项可移植配置测试，以及类型、协议生成和源码凭据检查；这些结果不代替真机验收。

Live cloud proof also passed using the native Kotlin Agent implementation: real model/tool round, global and phone memory writes, fresh-session recall, and phone → cloud → Mac filename-search receipts. Test facts and the unique file were cleaned up; this is a desktop JVM proof, not physical-phone verification. SDK startup identity checks now recover after an unavailable tunnel without replaying execution.

原生 Kotlin Agent 的真实云端联调也已通过：模型工具循环、全局／手机事实保存、新会话召回、手机经云端下发 Mac 文件搜索并回传。已清理唯一测试事实和文件；这是电脑上的 JVM 实现联调，不是真机验收。SDK 已修复首次隧道未就绪后无法恢复的问题，恢复连接不会重放执行。
