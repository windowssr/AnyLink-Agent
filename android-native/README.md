# AnyLink Android：手机本地 Agent

从 **0.4.0-preview.1** 起，Android 自己管理会话、模型工具循环和执行记录，统一连接 AnyLink 服务器。**Mac 关机不影响手机聊天或手机工具**，只会让交给 Mac 的任务等待。旧的 0.2.x 是依赖 Mac Gateway 的形象／交互预览，不是当前产品的接入方式。

工程复用固定 OpenClaw `v2026.11.6` 的 Android 构建底座和人物呈现组件，产品入口是 `ai.openclaw.app.anylink.AnyLinkActivity`。它不会创建 `NodeRuntime`、连接 Gateway、做 OpenClaw 配对或启动旧节点服务。上游源码按固定提交获取，不复制到本仓库；产品源码集只编译本地 Agent、人物呈现、动画设置读取和许可加载，不编译旧 Gateway 节点运行时。Android 12 / API31+。

## 通路

```text
Android：原生人物 / 文字 / 系统语音
  → 本机 DeviceAgent：会话、工具循环、SQLite 记录
    → AnyLink HTTPS 服务器：设备身份、统一记忆、模型 SSE、任务中继
      → DeepSeek Flash（模型 Key 只在服务器）

跨设备：手机 task_create → 云端路由 → Mac/其他设备 Agent 领取
       → 本机策略限制的执行 → 云端持久回执 → 手机任务面板
反向：其他设备把 phone.status / companion.say 路由到这台手机
       → 前台 worker 领取并执行 → 结果回传云端
Mac 文件操作：agent.ask → mac-openclaw Agent → 本机 OpenClaw remote Agent
       → anylink_files_* 受限工具（读写/整理/移动/删到废纸篓/打开）
```

当前手机工具是基础设备信息、AnyLink 私有便笺、统一记忆的查询／明确保存／修订／删除（global／device／agent 三层）、表情动作，以及跨设备的 link_directory／task_create／task_status／task_cancel。Mac 的 `mac-files` Agent 提供 `files.search` 文件名搜索；Mac 的 `mac-openclaw` Agent 提供 `agent.ask`，把完整中文指令交给 Mac 上的大肥鱼在开放目录内读写、整理、移动、删到废纸篓或打开文件（无确认、删除进废纸篓、需 Mac 保持唤醒）。App 在前台时还会声明 `phone.status`（读取型号、系统版本、电量等）和 `companion.say`（让大肥鱼用语音说一句话并显示在屏幕上，text ≤500 字）两个能力供其他设备派发。没有沿用旧 Gateway 的手机操作能力，不能宣称能点击其他 App、读相册或操控全屏。后续逐项接原生能力和权限。

## 连接

1. 部署 AnyLink 服务，准备远程 **HTTPS 根地址**。服务器仅监听回环时，需要由部署者提供受保护入口；不能把 Mac 的 `127.0.0.1` 地址直接填到手机。
2. 在 App 的“服务器连接”填写地址和主人签发的**加入密钥**（可选填设备名称，默认手机型号），点击“验证并连接”。手机以 `android-dafeiyu` Agent 身份接入；加入密钥只用于本次请求，**不会写入磁盘**，保存的只有加密后的设备令牌。无需 OpenClaw 地址和 Token，无需重新编译来绑定设备。
3. 旧版设备凭据 JSON 仍可通过“导入旧版设备凭据 JSON”导入；此时 Agent 身份从 `/edge/v1/identity` 读取。若手机上存有同一服务器的旧凭据，加入流程会先用旧令牌调用 `POST /edge/v1/device/install-id` 认领 install_id，使新 Agent 落在**同一台设备**上、保留设备级记忆；旧令牌已撤销时自动按新设备接入并提示。
4. 凭据以 Android Keystore AES-GCM 加密，密文保存到应用私有 SQLite；会话、操作回执和便笺按服务器＋设备身份分库（新设备 ID 视为新分库，旧记录保留）。`install_id` 单独持久化，重连复用同一安装标识。APK 不内置任何密钥。

开发用 USB 只转发**服务器服务**，不是转发 Gateway：

```bash
ssh -N -L 3180:127.0.0.1:3180 YOUR_SERVER_ALIAS
adb reverse tcp:3180 tcp:3180
# 手机连接 http://127.0.0.1:3180 并导入自己的设备凭据
```

USB 是开发调试通道，不是正式产品对 Mac 的依赖。正式安装使用部署者自己的 HTTPS 地址，手机直接访问服务器。仓库不提供公共共享服务器或凭据。

## 交互、语音与可靠性

全屏形象接收本地的 idle / listening / thinking / working / speaking / attention 状态。输入、任务回执、失败与记录由原生界面呈现，人物 WebView 不接触凭据和设备操作。

语音识别使用 Android `SpeechRecognizer`（优先本机服务，设备不支持时使用系统服务），系统服务商可能在线处理语音。播报优先走云端 `POST /model/v1/speech`：服务端清洗文字（去代码、表格、Markdown、链接、表情），可选让 DeepSeek 改写成一两句口播稿，再用微软语音合成甜美女声 mp3，App 用 `MediaPlayer` 播放并驱动人物 speaking 状态；新一轮主人回复会打断当前播报，`companion.say` 消息排队追加。合成失败或服务端 502 时回退到系统 `TextToSpeech` 朗读 `spoken_text`（服务端不可达时用本地同口径清洗的文字）。点击“说话”会停止旧模型回复与播放，识别完整句子后交给本机 Agent。当前提供显式停止，不承诺全双工、自动开口打断或 Grok 延迟；收音、回声、GPU 和实际手机生命周期待真机验证。

每轮注入最近十条全局和十条设备事实的有界要点，各作用域独立预算；需要更早或完整事实时通过记忆搜索读取，避免全局内容挤掉手机事实。

工具参数只有在 SSE `finish_reason` 和 `[DONE]` 都完整后才执行。工具执行前先写 SQLite；中断状态不会在重启后重放。写请求带幂等键，记忆修订带 revision。任务创建结果未知不会自动再创建，云端排队也不等于执行完成。切换会话保留共同记忆，设备私有便笺不冒充统一记忆。

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

`--test` 覆盖手机自己的真实 HTTP 模型／工具循环、缺失终止事件不执行、身份不匹配、未请求写记忆、跨设备排队、SQLite 重启不重放、凭据不随重定向转发和服务器连接界面。它不等于真机验收。`acceptance.mjs` 已替换为独立手机 Agent 的真实云端联调入口，不通过 Mac Gateway。

旧 `configure-preview.mjs`、旧 Gateway 原生 Talk 适配及其测试已退出产品主线；`android/` HBuilderX 工程只保留作历史原型。不要用旧预览的验收记录证明当前 Android 的真实硬件能力。
