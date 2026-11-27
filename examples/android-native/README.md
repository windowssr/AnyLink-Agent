# Android 端参考客户端（原生独立 Agent · 大肥鱼）

> 本目录属于 `examples/` 展示实例，与核心协议（`protocol/`）、云端中枢（`server/`）和 SDK（`sdk/`、`sdk-python/`、`mcp/`）完全隔离。

Android 客户端直接在手机本地运行完整的 Agent 会话、工具循环与 SQLite 幂等账本，**不依赖 Mac 在线或任何 Gateway**；仅在需要操作电脑时通过 AnyLink 云端 Protocol v3.2 与 Mac 实时联动。

---

## 本次发布范围与升级

最新预览版：[v0.10.0-preview.12 · 公开 APK 与发布说明](https://github.com/windowssr/AnyLink-Agent/releases/tag/v0.10.0-preview.12)。

相对 preview.8，本次同时修改了 **Android App 和配套服务器语音网关**（`server/config.ts`、`server/speech.ts`、`server/qwen-speech.ts`），电脑端、SDK 和 MCP 没有修改。服务器包版本号仍为 0.9.2，协议编号保持 v3.2；版本号相同不代表本次服务端代码未变化。

要使用 Momo 分片播放，需要更新配套服务器并配置百炼 Key；未配置时保留原微软语音，再由手机系统 TTS 兜底。旧服务器仍可通过原 JSON 音频响应与新版 App 通信，但没有新增的 PCM 流式能力。发布说明包含配置、兼容范围及本轮验证结果。

## 一、核心特性与前端架构（Android `0.10.0-preview.12`）

- **透明人物舞台与 SVG 图标**：主界面显示半身，通话页将人物放大至小腿以上、不露脚，阅读模式缩小人物。WebView 明确使用 `MATCH_PARENT`，避免网页零高度；Live2D 就绪同时验证可见布局和真实 GPU 像素。私有版加载失败使用私有形象兜底，公开版使用原创矢量形象。界面操作图标来自 `web/icons/` 的 SVG 源文件，并生成原生 VectorDrawable；修改路径定义后运行 `node examples/android-native/scripts/generate-icons.mjs`。
- **本地离线、系统与可选云端 ASR**：本地使用 sherpa-onnx 2.0.3 与约 199 MiB 中英流式模型，无需云端密钥，使用束搜索并给人物名称“大肥鱼”加入适度热词偏置。顶栏「保活」下载模型并校验 SHA-256 后即可用于语音输入、通话和本地测试；自动模式优先使用已下载模型，手动系统模式保留原调用。本地模式的录音只在手机内转写，识别后的文字按原有聊天流程发送；对话与回复仍需要 AnyLink 服务器。录音会话独立管理，取消后的回调、超时和 HTTP 响应不能进入下一轮。
- **电话式语音界面**：接通/挂断音效、静音、居中挂断、听筒/外放，点人物可停止播报并继续说话。使用 API 31+ 通信设备路由，界面跟随系统确认的输出；结束通话恢复音频模式。当前采用自动轮流听说，播放结束后恢复识别，不宣称已实现外放下的全双工开口打断。
- **悬浮窗透明度**：在「保活」中设置 0–80% 透明度，修改即时生效并保存，重建悬浮窗后继续使用。
- **Momo 云端播报与原始语音兜底**：服务器配置百炼 Key 后，默认使用阿里云 `qwen3-tts-flash-realtime` 的茉兔 `Momo`，语速默认 1.12 倍。失败时先回退原来的微软 `XiaoyiNeural`，再回退手机系统 `TextToSpeech`；Kokoro 不参与播报。通话按短句提前合成，Momo 的 PCM 片段通过同一个 HTTPS 接口边传边由 `AudioTrack` 播放，最多预取一句；取消会关闭请求、清空预取和音频缓冲。同一轮一旦降级，不再跳回主音色，下一轮才重新尝试 Momo；已播放的流中断时提示重试，不换声从头重播。顶栏「保活 → 大肥鱼的声音」可试听并查看最近实际使用的声音。
- **开口前准备**：连接与通话开始时预检设备及协议，成功结果在同一连接实例内缓存 60 秒；记忆和模型接口仍逐次进行服务端鉴权。聊天、后台控制与 TTS 共用 HTTPS 连接池，各自保留独立取消范围。流式音频的起播阈值为 50ms，并保留后续缓冲；诊断补充设备检查、记忆、模型首 token 和首句生成的阶段耗时。
- **文字和声音同步**：普通聊天随模型流式输出提前请求前两句口播，直接使用原句，不再等完整回复后再调用模型重写。陪伴视图按实际播放开始逐句展示；展开阅读随时可看完整文字。通话字幕只显示当前播报句，口型由实际播放头驱动。长工具结果和通知仍由服务器按共享人设精炼，客户端不再维护另一套改写提示词。通话期间普通通知延后到挂断音效结束后播放。
- **真实音频口型与句子动作**：Momo 流式 PCM、原微软 MP3 和系统 TTS WAV 共用播放状态、口型和字幕时钟；本地 TTS 等待初始化并合成音频文件。流式 PCM 直接计算 20ms RMS，其余格式预解码；按实际播放进度驱动嘴部，静音时闭嘴；字幕使用实际口播，句子开始播放时触发适量挥手、点头或指示动作，打断和挂断取消动作并收口。
- **聊天内文件预览与持久记录**：接收文件仍保存到“下载/AnyLink”。聊天中显示图片、视频封面、PDF 首页和有长度上限的文本预览；图片可以放大。文件卡片、保存 URI 和接收状态独立存入 SQLite，重启可恢复，不混入模型上下文；未完成接收显示中断。系统打开与分享通过 content URI 授予临时只读权限。
- **原生 Markdown 与交互卡片**：保留多轮聊天、代码块、列表、表格、跨设备任务确认和追问。
- **极简登录验证**：
  - 只需填写 **HTTPS 服务器地址** 与 **预设登录密码（或加入密钥）** 即可一键接入，自动签发并加密保存专属设备令牌（Android Keystore AES-GCM），密码绝不落盘。
  - 展开「高级选项」可自定义设备名称、唯一短别名 `slug`（如 `my-phone`）或导入旧版凭据 JSON。
- **弱网韧性与后台保活**：
  - WebSocket 支持 `resume_after_seq` 游标续传、20 秒心跳 + 15 秒 Pong 死链检测、Full Jitter 指数退避、`task.receipt_ack` 回执确认；流式对话支持 `X-AnyLink-Detach-On-Disconnect: on` 断线续接；离线记忆自动写入 SQLite `memory_outbox` 并在重连后自动补发。
  - 连接成功后自动拉起常驻前台服务 `AnyLinkCompanionService`（不强依赖悬浮窗权限），开启悬浮窗权限后退后台显示轻量化原生大肥鱼悬浮球（点按说话、长按回 App、拖动换位、拖至底部 `×` 隐藏）。
- **跨设备双向传文件（200 MiB O(1) 内存流式 + Protocol v3.2 能力/容量协商）**：
  - 输入栏左侧点 附件按钮 通过系统文件选择器选任意文件：上传前自动从 `/edge/v1/protocol` 与 `/edge/v1/directory` 预检云端与目标电脑的文件策略与上限，超限或对方关闭收文件时直接拦下提示，不浪费流量；通过后留空文字点「发文件」直接一键流式发往 Mac（`~/Downloads/AnyLink/`），输入附言则携带 `artifact_id` 交由电脑 Agent 处理。
  - 接收 Mac 发来的文件时先校验本机开关、单文件上限与 `StatFs` 剩余存储空间；超过大文件确认阈值（默认 50 MB）时先弹出紧急通知与聊天确认卡片，等主人确认后再流式写入手机「下载/AnyLink」（`MediaStore.Downloads`）并校验 SHA-256，生成带「打开文件 / 分享」按钮的文件卡片。
  - 顶栏「**保活**」内提供完整的「跨设备接收文件策略」开关与档位（允许收文件开关、单文件上限 `50 MB / 200 MB / 500 MB / 1 GB`、大文件弹窗阈值 `不弹窗 / 20 MB / 50 MB / 100 MB`），修改后实时同步至云端。
- **对称双向跨设备操控 + 可配置执行步数上限 + 主动弹窗通知**：
  - 不仅支持手机向 Mac 发起 `task_invoke` / `task_reply` / `file_send`，**也完整支持 Mac 等其他设备向手机下发 `agent.invoke`**：手机后台 Worker 会将远程指令路由到本机 `DeviceAgent`（携带无障碍 `phone_*` 操控工具）实际执行并实时推送进度；可在「保活」页随时开关「允许 Mac 等设备远程操控本机」，未开无障碍或锁屏时返回临时拒绝（`learn_boundary: false`），并在连网时自动清理历史陈旧的 `PHONE_REMOTE_SCOPE_LIMITED` 边界。
  - 手机 Agent 默认单轮上限 **100 步**（可在顶栏「保活」设置中切换 `50 步 / 100 步 / 200 步 / 不限`），控屏循环内每步实时裁剪旧屏幕防上下文膨胀，历史对话超长自动滑动压缩，跑满上限后一键点「继续执行」无缝续跑。
  - Mac 主动发来消息、文件或完成任务时通过 `IMPORTANCE_HIGH` 渠道「大肥鱼主动消息」弹出顶部横幅通知与人设口播。

---

## 二、数据通路（Protocol v3）

```text
Android 原生界面（Live2D 舞台 + Markdown 对话流 + 本地/系统/可选云端语音输入 / 全屏实时通话）
  → 本机 DeviceAgent（会话 / 工具循环 / 远程 agent.invoke 执行 / SQLite 幂等账本）
    → AnyLink Cloud Hub (HTTPS + WSS /edge/v1/ws)
      ├── 云端记忆大脑：/edge/v1/memory/assemble & /edge/v1/memory/ingest
      ├── 多模型与语音网关：/model/v1/chat/completions (SSE) · /model/v1/speech · /model/v1/audio/transcriptions
      └── 跨设备实时总线：/edge/v1/tasks + /edge/v1/artifacts + /edge/v1/ws 推送
```

---

## 三、构建、测试与安装步骤

首次构建需要 JDK 17、Android SDK（同意 Google 许可）及本仓库提供的构建脚本（工具链下载到 gitignored 的 `data/android-native/`）：

### 1. 准备工具链（仅首次）
```bash
node examples/mac-openclaw/install-runtime.mjs
node examples/android-native/scripts/install-toolchain.mjs --accept-sdk-license
node examples/android-native/scripts/install-gradle.mjs
```

### 2. 运行单元测试（Robolectric + Compose UI）
```bash
node examples/android-native/scripts/build.mjs --test
```

### 3. 构建公开版 APK（原创 SVG 形象，可公开分发）
```bash
node examples/android-native/scripts/build.mjs
node examples/android-native/scripts/inspect-apk.mjs
# 产物：artifacts/android-native/AnyLink-Android-<version>.apk
```

### 4. 构建个人私有版 APK（含本地已授权 Live2D 形象，仅自用、禁止公开分发）
> 需先在本地按 `examples/mac-openclaw/companion/ASSET-NOTICE.md` 获取第三方素材到 `data/mac/companion/`。构建脚本会自动将手机纹理缩放到 1024px 以降低移动端 WebGL 显存占用。
```bash
npm --prefix examples/android-native run build:private
node examples/android-native/scripts/inspect-apk.mjs --private
# 产物：artifacts/android-native/AnyLink-Android-<version>-private.apk
```

### 5. 安装到真机
开启手机「USB 调试」连接电脑，使用项目内置 `adb` 安装（或直接把 APK 传到手机点击安装）：
```bash
data/android-native/sdk/platform-tools/adb devices
data/android-native/sdk/platform-tools/adb install -r artifacts/android-native/AnyLink-Android-0.10.0-preview.12.apk
# 已使用私有 Live2D 版的本地自用设备，改为安装同版本 -private.apk
```

---

公开版与私有版使用相同的开发包名和签名，覆盖安装会切换形象资源。需要保留大肥鱼 Live2D 的自用设备，应安装本地私有版；GitHub Release 只提供原创 SVG 形象的公开版。

## 四、真机使用与后台保活配置

1. 打开 App，填写 **HTTPS 服务器地址**（例如 `https://anylink.example.com`）和 **登录密码 / 加入密钥**，点击「验证并连接」。
2. 顶栏出现绿点 `Protocol v3.2 · @my-phone · WS 实时在线` 即连接成功。
3. 点击顶栏「**保活**」：
   - **通知权限**：建议开启，保持前台保活通知正常显示。
   - **电池优化**：强烈建议在国产 ROM（小米/华为/OPPO/vivo/荣耀等）里设为「无限制 / 允许后台高耗电」，避免锁屏或隐藏后被系统强杀。
   - **悬浮权限**（可选）：开启后切后台出现轻量化悬浮球。
   - **无障碍权限**（可选）：开启后可语音或文字让大肥鱼自动操作手机 App（Android 13+ 侧载包需先在「应用信息」右上角允许「受限设置」）。
   - **本地离线识别**：下载识别模型（约 199 MiB），成功后自动选中本地模式；「测试本地识别」只显示结果，不发送聊天消息。模型下载源、固定修订和文件摘要在 `offline-asr-lock.json`，模型保存在 App 私有目录，同一模型在更新安装包后可继续使用。

构建准备阶段自动下载并校验固定版 sherpa-onnx AAR，缓存到忽略目录 `data/android-native/offline-asr/`。AAR 随公开版和私有版客户端分发，模型在手机上另行下载；两者的许可证位于 `licenses/`，模型二进制不提交仓库。

### 云端 Momo 配置（仅服务器）

百炼北京地域创建 API Key，使用 `ANYLINK_QWEN_TTS_API_KEY_FILE` 指向只允许服务进程读取的密钥文件，或由部署环境注入 `ANYLINK_QWEN_TTS_API_KEY`。也支持 `DASHSCOPE_API_KEY` / `DASHSCOPE_API_KEY_FILE`。密钥不写入安装包和客户端连接配置。

```bash
ANYLINK_TTS_PROVIDER=qwen
ANYLINK_QWEN_TTS_REGION=beijing
ANYLINK_QWEN_TTS_MODEL=qwen3-tts-flash-realtime
ANYLINK_QWEN_TTS_VOICE=Momo
ANYLINK_QWEN_TTS_SPEECH_RATE=1.12
ANYLINK_QWEN_TTS_API_KEY_FILE=/run/secrets/dashscope-api-key
```

Docker 部署若使用 `_FILE`，需将密钥文件只读挂载到容器内对应路径；也可在现有受限权限 `app.env` 中注入 Key。没有 Key 时保持原来的微软主声音；显式设置 `ANYLINK_TTS_PROVIDER=microsoft` 可恢复原主方案。这里改变的是播报合成，已有手机本地离线识别继续使用。

服务器通过官方 WebSocket 接口接收 PCM。Android 使用 `Accept: application/x-ndjson` 在 `/model/v1/speech` 请求分片流：`start` 指定当前口播、实际音色与 24kHz PCM16 单声道格式，`audio` 携带音频，`done` 明确结束；缺失结束事件或中途报错会停止这轮播放。未请求此类型的客户端继续收到原 JSON/WAV/MP3 响应。首段尚未产生时仍可回退原微软 MP3，再由系统 TTS 兜底。字幕为短句同步，不提供逐字对齐承诺。待播报文字会发往阿里云，微软兜底时发往微软；原始本地识别录音不经此合成接口上传。

## 五、本机视觉与语音样本检查

```bash
node --import tsx examples/android-native/scripts/create-preview-audio.mjs
node examples/android-native/scripts/preview.mjs
# http://127.0.0.1:5181/ — 读取本地已授权 Live2D 素材
# 加 --public 使用不含私有素材的原创半身形象，端口 5182
```

预览页覆盖陪伴/阅读、文件卡片、PDF 示例、语音输入状态和电话式控制。点击“播放语音与口型”使用固定中文样本和 Web Audio 实际音量，不启用麦克风、不发送任务。预览不能替代真机系统识别、听筒/耳机路由和后台生命周期验收。

本轮通过 87 项 Android Agent/Compose/phone 测试、13 项脚本测试，配套服务通过 61 项数据库集成测试及 SDK/类型/协议检查。测试覆盖首音频早于合成结束、播放头字幕、预取上限、取消、同轮降级固定及通知延后。可在「保活 → 大肥鱼的声音 → 复制播报诊断」查看最近 60 条事件，包含来源、请求 ID、实际供应商、耗时和降级原因，不记录正文、录音、令牌或 API Key。HONOR BRP-AN80 / Android 15 上已检查私有版 Live2D 显示、阅读视图、前后台切换、冷启动、本地转写和语音通话回复；本轮真机再次核对了 Momo 分片播放、字幕同步和首声速度。一次观测从识别结果交给 Agent 到开口约 2.5 秒，首句生成到开始播放约 0.77 秒；这是单次实测，不包含说话结束判定和转写耗时，也不是通用延迟保证。同音字准确率仍需后续优化，长时间后台通话、蓝牙/有线耳机及外放全双工尚未完整验收。

发布 APK 从已提交的干净源码构建，记录完整 `source` 和 `source_dirty: false`；公开 Release 提供公开 APK、`release-manifest.json` 和 `SHA256SUMS`。私有 APK、Live2D 模型素材与 Cubism Core 只保留本机；本地 ASR 模型从固定公开源另行下载，不随 APK 或源码分发。
