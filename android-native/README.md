# AnyLink Android：手机本地 Agent

从 **0.5.0-preview.1** 起，Android 自己管理会话、模型工具循环和执行记录，统一连接 AnyLink 服务器。**Mac 关机不影响手机聊天或手机工具**，只会让交给 Mac 的任务等待。旧的 0.2.x 是依赖 Mac Gateway 的形象／交互预览，不是当前产品的接入方式。

工程复用固定 OpenClaw `v2026.11.6` 的 Android 构建底座和人物呈现组件，产品入口是 `ai.openclaw.app.anylink.AnyLinkActivity`。它不会创建 `NodeRuntime`、连接 Gateway、做 OpenClaw 配对或启动旧节点服务。上游源码按固定提交获取，不复制到本仓库；产品源码集只编译本地 Agent、人物呈现、动画设置读取和许可加载，不编译旧 Gateway 节点运行时。Android 12 / API31+。

## 通路（Protocol v3）

```text
Android：原生人物 / 文字 / 语音
  → 本机 DeviceAgent：会话、工具循环、SQLite 幂等账本
    → AnyLink Cloud Hub (HTTPS + WSS /edge/v1/ws)
      ├── 云端记忆大脑：/edge/v1/memory/assemble（跨设备共享记忆 + 边界经验 + 近期动态）
      │              & /edge/v1/memory/ingest（去抖批整理 + 闲聊过滤）
      ├── 多模型网关：/model/v1/chat/completions (SSE) & /model/v1/speech（中性接口 + style="persona"）
      └── 跨设备实时总线：/edge/v1/tasks + /edge/v1/ws 实时推送

跨设备正向：手机 task_invoke（支持 @device_slug，无需查能力表）→ 云端路由 → Mac/其他设备立即 WS 唤醒执行
         → task.progress 实时进度 & task.completed 推回手机 → 大肥鱼主动语音汇报结果或 declined 原因
跨设备反向：其他设备把指令或 phone.status / companion.say 路由到这台手机
         → WS 实时唤醒前台 worker 执行 → 结果回传云端（超出范围时返回 declined 供云端自动学习边界）
Mac 文件与协作：agent.invoke / agent.ask → mac-openclaw Agent → 本机 OpenClaw remote Agent
         → anylink_files_* 受限工具（读写/整理/移动/删到废纸篓/打开）
```

当前手机工具包括：基础设备信息、AnyLink 私有便笺、统一记忆的查询／明确保存／修订／删除（global／device／agent 三层）、表情动作、跨设备的 `link_directory`／`task_invoke`（自然语言免能力表调用，支持 `target_device_slug`）／`task_create`／`task_status`／`task_cancel`，以及本机手机操作工具 `phone_screen`／`phone_open_app`／`phone_list_apps`／`phone_tap`／`phone_type`／`phone_scroll`／`phone_back`／`phone_home`（见下节）。Mac 的 `mac-files` Agent 提供 `files.search` 文件名搜索；Mac 的 `mac-openclaw` Agent 响应 `agent.invoke` / `agent.ask`，把自然语言指令交给 Mac 上的大肥鱼在开放目录内读写、整理、移动、删到废纸篓或打开文件（遇到无法执行的动作会主动返回 `declined`，由云端记忆大脑自动记住该边界）。App 在前台或悬浮服务运行时建立 `/edge/v1/ws` 长连接并声明 `phone.status` 与 `companion.say` 能力，同时支持 `agent.invoke` 自然语言调用。手机无障碍控屏工具只在本机对话中可用，不作为跨设备能力对外开放；没有沿用旧 Gateway 的相册、短信、通话记录等能力。

## 连接

1. 部署 AnyLink 服务，准备远程 **HTTPS 根地址**（Caddy 反代 `/edge/v1/*` 已原生支持 WebSocket 升级）。服务器仅监听回环时，需要由部署者提供受保护入口；不能把 Mac 的 `127.0.0.1` 地址直接填到手机。
2. 在 App 的“服务器连接”填写地址和主人签发的**加入密钥**（可选填设备名称与唯一短别名 `slug`，例如 `my-phone`，便于跨设备 `@my-phone` 精确寻址），点击“验证并连接”。手机以 `android-dafeiyu` Agent 身份接入；加入密钥只用于本次请求，**不会写入磁盘**，保存的只有加密后的设备令牌。无需 OpenClaw 地址和 Token，无需重新编译来绑定设备。
3. 旧版设备凭据 JSON 仍可通过“导入旧版设备凭据 JSON”导入；此时 Agent 身份从 `/edge/v1/identity` 读取。若手机上存有同一服务器的旧凭据，加入流程会先用旧令牌调用 `POST /edge/v1/device/install-id` 认领 install_id，使新 Agent 落在**同一台设备**上、保留设备级记忆；旧令牌已撤销时自动按新设备接入并提示。
4. 凭据以 Android Keystore AES-GCM 加密，密文保存到应用私有 SQLite；会话、操作回执和便笺按服务器＋设备身份分库（新设备 ID 视为新分库，旧记录保留）。`install_id` 单独持久化，重连复用同一安装标识。APK 不内置任何密钥。

开发用 USB 只转发**服务器服务**，不是转发 Gateway：

```bash
ssh -N -L 3180:127.0.0.1:3180 YOUR_SERVER_ALIAS
adb reverse tcp:3180 tcp:3180
# 手机连接 http://127.0.0.1:3180 并导入自己的设备凭据
```

USB 是开发调试通道，不是正式产品对 Mac 的依赖。正式安装使用部署者自己的 HTTPS 地址，手机直接访问服务器。仓库不提供公共共享服务器或凭据。

## 悬浮陪伴与操作手机（0.5.0-preview.1）

连接成功后，App 退到后台时大肥鱼会作为悬浮窗留在屏幕上（可在“悬浮与操作手机”里关闭）。悬浮窗约 120×180dp，复用同一套 Live2D 人物（mini 取景，只露头和上半身）；**点按说话**（再点或正在播报时打断）、**长按打开应用**、**拖动换位置**（位置会记住并限制在屏幕内），拖到底部“×”目标可隐藏悬浮，重新打开 App 后恢复。

悬浮与播报依赖一个前台服务 `AnyLinkCompanionService`（`specialUse` + `microphone` 类型，常驻通知“ 大肥鱼在陪着你”，带 说话／隐藏悬浮／退出 操作）。Android 14+ 要求 `specialUse` 声明用途（本应用为悬浮陪伴），系统拒绝启动时会提示并回退为打开 App 说话。后台保活受厂商省电策略限制，长时间退后台可能被系统回收，此时重开 App 即可。

**操作手机**需要开启无障碍服务 `AnyLinkAccessibilityService`（设置 → 无障碍 → 大肥鱼）。开启后大肥鱼可以在对话中直接 `phone_screen` 读屏、`phone_tap`/`phone_type`/`phone_scroll` 操作、`phone_back`/`phone_home` 导航、`phone_open_app`/`phone_list_apps` 启动应用；所有动作**直接执行、不再逐步确认**，每次动作后约 600ms 返回一份新的紧凑屏幕。屏幕内容只作为数据返回模型，不会被当作指令。侧载安装的应用在 Android 13+ 可能需要先在“应用信息”里允许“受限设置”才能开启无障碍。节点编号只在下一次读屏前有效；本机工具不对外声明为跨设备能力。

需要的权限：`SYSTEM_ALERT_WINDOW`（悬浮窗）、`RECORD_AUDIO`（语音）、`POST_NOTIFICATIONS`（常驻通知）、`FOREGROUND_SERVICE(_SPECIAL_USE/_MICROPHONE)`（前台服务）、无障碍服务绑定。凭据仍只在应用私有加密存储，悬浮窗与无障碍服务都不接触凭据。

## 交互、语音与可靠性

全屏形象接收本地的 idle / listening / thinking / working / speaking / attention 状态。输入、任务回执、失败与记录由原生界面呈现，人物 WebView 不接触凭据和设备操作。

语音识别使用 Android `SpeechRecognizer`（优先本机服务，设备不支持时使用系统服务），系统服务商可能在线处理语音。播报优先走云端 `POST /model/v1/speech`：服务端清洗文字（去代码、表格、Markdown、链接、表情），可选让 DeepSeek 改写成一两句口播稿，再用微软语音合成甜美女声 mp3，App 用 `MediaPlayer` 播放并驱动人物 speaking 状态；新一轮主人回复会打断当前播报，`companion.say` 消息排队追加。合成失败或服务端 502 时回退到系统 `TextToSpeech` 朗读 `spoken_text`（服务端不可达时用本地同口径清洗的文字）。点击“说话”会停止旧模型回复与播放，识别完整句子后交给本机 Agent。当前提供显式停止，不承诺全双工、自动开口打断或 Grok 延迟；收音、回声、GPU 和实际手机生命周期待真机验证。

每轮优先调用云端记忆大脑 `POST /edge/v1/memory/assemble` 注入与当前问题相关的跨设备共享记忆、已学习的设备边界和近期动态（兼容旧版服务器时自动回退到 `/edge/v1/context`），并在回合结束后上报 `/edge/v1/memory/ingest` 由云端异步去抖整理；需要完整事实时可通过 `memory_search` 混合检索。

`CloudClient` 使用线程安全的并发调用集合追踪在途请求，聊天与后台 worker 隔离使用独立客户端实例，取消对话不会误伤任务回执。工具参数只有在 SSE `finish_reason` 和 `[DONE]` 都完整后才执行。工具执行前先写 SQLite；中断状态不会在重启后重放。写请求带幂等键，记忆修订带 revision。任务创建结果未知不会自动再创建，云端排队也不等于执行完成。切换会话保留共同记忆，设备私有便笺不冒充统一记忆。

## 构建、检查和资源

首次构建需要自行同意 Google Android SDK 许可。JDK17、固定 SDK / Gradle 与缓存位于忽略的 `data/android-native/`；Node构建依赖来自 `node mac/install-runtime.mjs` 准备的固定运行时，不需要私有人物素材。

```bash
node android-native/scripts/install-toolchain.mjs --accept-sdk-license
node android-native/scripts/install-gradle.mjs
node android-native/scripts/build.mjs
node android-native/scripts/build.mjs --test
node android-native/scripts/inspect-apk.mjs
node android-native/scripts/preview.mjs --public
```

### 模拟器（可选，用于真机不可用时的验收）

SDK 位于 `data/android-native/sdk`（gitignored）。安装模拟器与 arm64 系统镜像：

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=$PWD/data/android-native/sdk ANDROID_SDK_ROOT=$ANDROID_HOME
$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "emulator" "system-images;android-34;google_apis;arm64-v8a"
$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager create avd -n anylink-test -k "system-images;android-34;google_apis;arm64-v8a" -d "pixel_6"
$ANDROID_HOME/emulator/emulator -avd anylink-test -gpu host
$ANDROID_HOME/platform-tools/adb install artifacts/android-native/AnyLink-Android-0.4.0-preview.1-private.apk
```

模拟器上验证头像：`adb logcat -s AnyLinkAvatar`（页面 console 全量转发）、`adb exec-out screencap -p > shot.png`、`adb shell dumpsys meminfo ai.openclaw.app`。

### 私人角色构建（仅主人自己的手机）

公开 APK 使用占位图形，不含 Live2D 模型与 Cubism 核心。主人自己的设备可以构建包含私人形象的版本：

```bash
npm --prefix android-native run build:private   # 等价于 ANYLINK_CHARACTER_MODE=private + prepare + build
node android-native/scripts/inspect-apk.mjs --private
```

产物为 `artifacts/android-native/AnyLink-Android-<version>-private.apk`（gitignore）。`--private` 检查会断言模型文件与 Cubism 核心存在且 `build-info.json` 的 `private_character:true`；默认公开检查保持原有断言。公开打包脚本 `scripts/package-public-release.mjs` 显式拒绝任何 `-private` APK 或 `private_character!==false` 的产物。

公开 APK 使用原创占位形象，不含大肥鱼模型、纹理、派生头像与 Cubism Core。人物半身效果需要自行取得许可允许的素材；私有构建使用 `ANYLINK_CHARACTER_MODE=private`，不得未经授权公开分发。上游 MIT 和素材说明随包保留。

`--test` 覆盖手机自己的真实 HTTP 模型／工具循环、Cloud Memory Brain `assemble`/`ingest`、WebSocket 实时推送、并发请求安全取消、缺失终止事件不执行、身份不匹配、未请求写记忆、跨设备 `task_invoke`（含 `device_slug`）与 `declined` 边界回传、SQLite 重启不重放、凭据不随重定向转发和服务器连接界面。它不等于真机验收。`acceptance.mjs` 已替换为独立手机 Agent 的真实云端联调入口，不通过 Mac Gateway。

旧 `configure-preview.mjs`、旧 Gateway 原生 Talk 适配及其测试、以及早期 `android/` HBuilderX 原型已全部移除。不要用旧预览的验收记录证明当前 Android 的真实硬件能力。
