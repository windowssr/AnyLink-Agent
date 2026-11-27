# Android 端参考客户端（原生独立 Agent · 大肥鱼）

> 本目录属于 `examples/` 展示实例，与核心协议（`protocol/`）、云端中枢（`server/`）和 SDK（`sdk/`、`sdk-python/`、`mcp/`）完全隔离。

Android 客户端直接在手机本地运行完整的 Agent 会话、工具循环与 SQLite 幂等账本，**不依赖 Mac 在线或任何 Gateway**；仅在需要操作电脑时通过 AnyLink 云端 Protocol v3.2 与 Mac 实时联动。

---

## 一、核心特性与前端架构（`v0.9.2` 深海玻璃陪伴版）

- **全屏无遮挡 Live2D 舞台 + 磨砂玻璃双视图 + 原生 Markdown 渲染**：
  - 全屏深海浅蓝径向光晕与无裁剪 WebView 舞台：私有版构建自动把模型资产规范为纯 ASCII 路径（`dafeiyu.moc3`、`textures/texture_00.png` 等）避免 APK ZIP 编码问题，WebView 放行 `data:`/`blob:`、关闭移动端易引发黑屏的 MSAA、移除盖在 WebView 上的全屏遮挡层，并在「保活」页内置 **「大肥鱼形象引擎状态」** 诊断与一键重新加载按钮。
  - 底部磨砂玻璃对话面板支持一键切换「**陪伴视图**」与「**展开阅读**」（弹起输入法自动紧凑），完整展示多轮对话气泡（支持长按选择复制、**原生 Compose Markdown 渲染**：标题、加粗/斜体/删除线、行内与多行围栏代码块、列表、引用、表格、可点链接）以及 **Protocol v3.2 高危审批 / 追问交互卡片**。
- **双引擎语音输入 + 全屏 Live2D 实时通话 + 独立人设口播改写**：
  - **语音输入**：输入栏常驻 `🎤` 按钮，支持实时声波条、边说边转文字预览与一键「说完了 / 取消」。内置双引擎（在「保活」页可切换「自动 / 云端识别 / 系统识别」）：优先使用系统在线/厂商 `SpeechRecognizer`，当无 GMS 或系统识别不可用时自动无缝回退到通用 `AudioRecord`（16 kHz PCM16 + 回声消除 AEC + 降噪 + 自适应静音检测 VAD）→ 云端 `POST /model/v1/audio/transcriptions`。
  - **全屏实时通话**：点击顶栏 **「📞 通话」** 进入全屏 Live2D 实时通话界面——免手连续多轮对话、逐句流式抢先合成播报（`VoiceSentenceChunker` 边生成边说话）、Live2D 实时口型联动（`audioLevel`）、随时点击 **「打断」** 抢话、支持 **静音 / 扬声器与听筒切换 / 挂断**，通话中依然可操控手机或调起 Mac 跨设备任务，挂断后记录自动保留。
  - **简洁核心人设口播**：普通聊天与跨设备回执播报强制传 `rewrite: "always"` + `style: "persona"`，若 `/model/v1/speech` 失败或未改写还会自动补一次轻量 `/model/v1/chat/completions` 人设提炼调用，只念 1–2 句核心口语，不念代码与 Markdown 符号。
- **极简登录验证**：
  - 只需填写 **HTTPS 服务器地址** 与 **预设登录密码（或加入密钥）** 即可一键接入，自动签发并加密保存专属设备令牌（Android Keystore AES-GCM），密码绝不落盘。
  - 展开「高级选项」可自定义设备名称、唯一短别名 `slug`（如 `my-phone`）或导入旧版凭据 JSON。
- **弱网韧性与后台保活**：
  - WebSocket 支持 `resume_after_seq` 游标续传、20 秒心跳 + 15 秒 Pong 死链检测、Full Jitter 指数退避、`task.receipt_ack` 回执确认；流式对话支持 `X-AnyLink-Detach-On-Disconnect: on` 断线续接；离线记忆自动写入 SQLite `memory_outbox` 并在重连后自动补发。
  - 连接成功后自动拉起常驻前台服务 `AnyLinkCompanionService`（不强依赖悬浮窗权限），开启悬浮窗权限后退后台显示轻量化原生大肥鱼悬浮球（点按说话、长按回 App、拖动换位、拖至底部 `×` 隐藏）。
- **跨设备双向传文件（200 MiB O(1) 内存流式 + Protocol v3.2 能力/容量协商）**：
  - 输入栏左侧点 `📎` 通过系统文件选择器选任意文件：上传前自动从 `/edge/v1/protocol` 与 `/edge/v1/directory` 预检云端与目标电脑的文件策略与上限，超限或对方关闭收文件时直接拦下提示，不浪费流量；通过后留空文字点「发文件」直接一键流式发往 Mac（`~/Downloads/AnyLink/`），输入附言则携带 `artifact_id` 交由电脑 Agent 处理。
  - 接收 Mac 发来的文件时先校验本机开关、单文件上限与 `StatFs` 剩余存储空间；超过大文件确认阈值（默认 50 MB）时先弹出紧急通知与聊天确认卡片，等主人确认后再流式写入手机「下载/AnyLink」（`MediaStore.Downloads`）并校验 SHA-256，生成带「打开文件 / 分享」按钮的文件卡片。
  - 顶栏「**保活**」内提供完整的「跨设备接收文件策略」开关与档位（允许收文件开关、单文件上限 `50 MB / 200 MB / 500 MB / 1 GB`、大文件弹窗阈值 `不弹窗 / 20 MB / 50 MB / 100 MB`），修改后实时同步至云端。
- **对称双向跨设备操控 + 可配置执行步数上限 + 主动弹窗通知**：
  - 不仅支持手机向 Mac 发起 `task_invoke` / `task_reply` / `file_send`，**也完整支持 Mac 等其他设备向手机下发 `agent.invoke`**：手机后台 Worker 会将远程指令路由到本机 `DeviceAgent`（携带无障碍 `phone_*` 操控工具）实际执行并实时推送进度；可在「保活」页随时开关「允许 Mac 等设备远程操控本机」，未开无障碍或锁屏时返回临时拒绝（`learn_boundary: false`），并在连网时自动清理历史陈旧的 `PHONE_REMOTE_SCOPE_LIMITED` 边界。
  - 手机 Agent 默认单轮上限 **100 步**（可在顶栏「保活」设置中切换 `50 步 / 100 步 / 200 步 / 不限`），控屏循环内每步实时裁剪旧屏幕防上下文膨胀，历史对话超长自动滑动压缩，跑满上限后一键点「继续执行」无缝续跑。
  - Mac 主动发来消息、文件或完成任务时通过 `IMPORTANCE_HIGH` 渠道「大肥鱼主动消息」弹出顶部横幅通知与人设口播。

---

## 二、数据通路（Protocol v3）

```text
Android 原生界面（Live2D 舞台 + Markdown 对话流 + 双引擎语音输入 / 全屏实时通话）
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

### 3. 构建公开版 APK（原创占位形象，可公开分发）
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
data/android-native/sdk/platform-tools/adb install -r artifacts/android-native/AnyLink-Android-0.9.2-private.apk
```

---

## 四、真机使用与后台保活配置

1. 打开 App，填写 **HTTPS 服务器地址**（例如 `https://anylink.example.com`）和 **登录密码 / 加入密钥**，点击「验证并连接」。
2. 顶栏出现绿点 `Protocol v3.2 · @my-phone · WS 实时在线` 即连接成功。
3. 点击顶栏「**保活**」：
   - **通知权限**：建议开启，保持前台保活通知正常显示。
   - **电池优化**：强烈建议在国产 ROM（小米/华为/OPPO/vivo/荣耀等）里设为「无限制 / 允许后台高耗电」，避免锁屏或隐藏后被系统强杀。
   - **悬浮权限**（可选）：开启后切后台出现轻量化悬浮球。
   - **无障碍权限**（可选）：开启后可语音或文字让大肥鱼自动操作手机 App（Android 13+ 侧载包需先在「应用信息」右上角允许「受限设置」）。
