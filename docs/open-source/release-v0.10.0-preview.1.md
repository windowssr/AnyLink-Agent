# AnyLink Android v0.10.0-preview.1

Android client preview using Protocol v3.2. The Cloud Hub, SDK, MCP adapter and macOS client remain at v0.9.2; this release contains the public Android APK.

## Voice input and calls

- Check recognition-engine availability before capture. Automatic mode uses a configured cloud ASR service or the phone's system recognition service; cloud ASR remains optional.
- Isolate capture callbacks and HTTP requests per session, add recognition timeouts, and cancel retired speech requests so interrupted replies cannot play in a later turn.
- Wait for local TTS initialization and synthesize its fallback to an audio file, using the same playback queue as cloud TTS.
- Simplify the call screen to mute, hang up, and earpiece/speaker controls. Follow the system-confirmed communication device, restore audio mode after calls, and request playback focus without competing with system recognition during capture.
- Support automatic turn-taking; tap the character to interrupt playback or retry recognition. Echo-safe full-duplex voice interruption has not been verified.

## Character, icons and files

- Drive mouth opening from decoded audio RMS and the actual playback clock, close the mouth during silence, and trigger restrained gestures when spoken sentences begin.
- Stop speech gestures and mouth movement on interruption or hang-up. Display a transparent half-body stage and an original half-body fallback, with compact framing in reading mode.
- Replace emoji controls with shared SVG paths and native VectorDrawables.
- Preview images, video covers, PDF first pages and bounded text inside chat. Persist file cards and saved URIs independently of model history, restore them after restart, and use content URIs for system open/share actions.
- Update the localhost preview with file and call layouts plus an actual speech sample for mouth/gesture checks.

## Validation and installation

- 53 Android Agent/Compose/phone tests and 6 configuration/download script tests passed.
- Type checks, protocol consistency, public source audit and public APK inspection passed. The localhost preview was checked for companion/reading layouts, file preview, a 360-pixel-wide call screen, speech completion and hang-up cancellation.
- Requires Android 12+. The APK is development/debug signed. Physical-device recognition, audio routing and background-call behavior still need hardware validation.
- The public APK contains original placeholder artwork, without private Live2D models, textures, Cubism Core or personal credentials. Private APKs stay local and are not release assets.
- Verify `SHA256SUMS` and `release-manifest.json` before installing.

---

本次是 Android 客户端预览版，协议保持 v3.2；云端服务、SDK、MCP 和 macOS 客户端仍为 v0.9.2。

本版改进系统识别和可选云端 ASR 的可用性检查、录音取消与 TTS 初始化；电话界面改为静音、挂断、听筒/外放，采用系统确认的通信音频路由。当前支持自动轮流听说、点人物打断，不承诺已完成外放环境下的全双工开口打断。

口型按实际音频与播放进度驱动，句子开始播报时联动动作，停止播放即收口；主界面与通话使用无圆框的半身舞台。操作图标统一使用 SVG 路径。聊天新增图片、视频封面、PDF 首页、文本预览，文件卡片和保存 URI 在重启后可恢复。

公开附件仅含无私有形象素材的 APK、发布清单和校验值。私有 Live2D APK 仅保留本地。手机没有系统识别服务时，需要另行配置云端 ASR；此次没有新增云端 ASR 配置。53 项 Android 测试、6 项脚本测试及发布审计已通过，录音、听筒/外放和后台连续通话仍待真机验收。
