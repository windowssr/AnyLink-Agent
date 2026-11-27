# AnyLink Android v0.10.0-preview.8

本次发布 Android 客户端预览版，协议保持 v3.2。云端服务、SDK、MCP 和 macOS 客户端仍为 v0.9.2。

## 本地语音与通话

- 新增 sherpa-onnx 2.0.3 本地离线识别。首次在「保活 → 本地离线识别」下载约 199 MiB 的中英流式模型，逐文件校验 SHA-256，通过后原子安装；无需云端 ASR 密钥。
- 自动模式优先使用已安装的本地模型，保留手动系统识别和可选云端 ASR。系统服务能否正常响应由手机提供；HONOR X60 的标准系统识别在独立对照程序中也未返回回调，本机可使用新增的离线引擎。
- 提供只在设置中显示结果的本地/系统识别测试、识别会话状态、超时与服务选择。模型下载可取消，模型在更新同版本配置的安装包后继续保留。
- 接通和挂断增加轻量音效。保持静音、挂断、听筒/外放控制和系统确认的音频路由，播放回复时暂停收音，播放完成后恢复监听。
- 本地转写不上传录音；识别后的文字仍按原有聊天流程交给服务器处理。通话是自动轮流听说，点击人物可停止播报继续说话。

## 人物显示与悬浮窗

- 修复 Compose 内 WebView 使用默认布局参数导致 HTML 高度为 0、引擎报告就绪但人物空白的问题。明确填满容器，验证页面尺寸及实际 GPU 像素后才报告就绪。
- 增加有期限的脚本加载、状态轮询、兼容模式重试及重新加载入口。忽略非必要 favicon 请求失败，避免其被误判为整个模型加载失败；私有版失败时使用私有形象兜底。
- 主界面显示透明半身，通话将人物放大至小腿以上、不露脚；保留实际音频驱动的口型与句子动作，操作图标使用 SVG 路径。
- 「保活」新增 0–80% 悬浮窗透明度设置，实时生效并保存。
- 延续 preview.1 的聊天文件预览、文件卡片持久化、公开/私有构建隔离。

## 验证与安装

- 79 项 Android Agent/Compose/phone 测试、13 项脚本测试、公开源码审计和两种 APK 的签名/资源检查通过。
- HONOR BRP-AN80 / Android 15 上验证了私有版 Live2D 显示、阅读视图、前后台切换、冷启动、本地转写与语音通话回复，用户确认听到了回复。同音字仍可能误识别，尚未进行通用准确率或延迟基准评估；长时间后台通话、蓝牙/有线耳机及外放全双工尚未完整验收。
- 需要 Android 12+。APK 使用开发/debug 签名。首次使用本地识别需要下载模型；公开 APK 本身只包含运行库与固定模型下载元数据，不包含 ASR 模型权重。
- **Release 仅提供公开版 APK、发布清单和 SHA-256 校验文件**。公开版使用原创 SVG 形象，不含私有 Live2D 模型、贴图、Cubism Core 或个人凭据。私有 APK 仅保留本地。
- 公开版和私有版的开发包名、签名相同，覆盖安装会切换形象资源；自用 Live2D 设备应继续安装本地 `-private.apk`。
- 安装前核对 `SHA256SUMS` 和 `release-manifest.json`。完整步骤见 [Android README](../../examples/android-native/README.md)。

---

This Android-only preview adds local Chinese/English recognition with sherpa-onnx 2.0.3 and a separately downloaded, SHA-256-pinned model (about 199 MiB). Local transcription needs no cloud ASR key; transcripts and replies continue through the existing server chat flow. System recognition remains selectable.

It fixes the zero-height WebView document that could report Live2D ready while clipping away the character, adds bounded loading/retry diagnostics, call entry/hang-up cues, larger call framing and saved floating-window transparency. Existing SVG controls, playback-driven lips/gestures and in-chat file previews are retained.

Validation: 79 Android tests, 13 script tests, source audit and public/private APK inspection passed. Basic private-build rendering, local transcription and audible call replies were checked on HONOR BRP-AN80 / Android 15. Homophone accuracy, long background calls, headset routes and echo-safe full-duplex interruption are not comprehensively validated.

The release contains only the public debug-signed APK, manifest and checksums. Private Live2D APKs/assets stay local; ASR weights are downloaded separately. Cloud Hub, SDKs, MCP and macOS remain at v0.9.2, protocol v3.2.
