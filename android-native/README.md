# AnyLink Android：手机本地 Agent

从 **0.3.0-preview.1** 起，Android 自己管理会话、模型工具循环和执行记录，统一连接 AnyLink 服务器。**Mac 关机不影响手机聊天或手机工具**，只会让交给 Mac 的任务等待。旧的 0.2.x 是依赖 Mac Gateway 的形象／交互预览，不是当前产品的接入方式。

工程复用固定 OpenClaw `v2026.11.6` 的 Android 构建底座和人物呈现组件，产品入口是 `ai.openclaw.app.anylink.AnyLinkActivity`。它不会创建 `NodeRuntime`、连接 Gateway、做 OpenClaw 配对或启动旧节点服务。上游源码按固定提交获取，不复制到本仓库；产品源码集只编译本地 Agent、人物呈现、动画设置读取和许可加载，不编译旧 Gateway 节点运行时。Android 12 / API31+。

## 通路

```text
Android：原生人物 / 文字 / 系统语音
  → 本机 DeviceAgent：会话、工具循环、SQLite 记录
    → AnyLink HTTPS 服务器：设备身份、统一记忆、模型 SSE、任务中继
      → DeepSeek Flash（模型 Key 只在服务器）

跨设备：手机 task_create → 云端排队 → Mac SDK Worker 领取
       → 本机策略限制的 files.search → 云端持久回执 → 手机任务面板
```

当前手机工具是基础设备信息、AnyLink 私有便笺、统一记忆的查询／明确保存／修订／删除、表情动作，以及已授权的跨设备任务创建／查询／取消。没有沿用旧 Gateway 的手机操作能力，不能宣称能点击其他 App、读相册或操控全屏。后续逐项接原生能力和权限。

## 连接

1. 部署 AnyLink 服务，准备远程 **HTTPS 根地址**。服务器仅监听回环时，需要由部署者提供受保护入口；不能把 Mac 的 `127.0.0.1` 地址直接填到手机。
2. 主人管理页注册 Android 逻辑设备，为真实手机生成自己的设备凭据 JSON。开发预览身份不等于已认证的物理手机。
3. 在 App 的“服务器连接”填写地址、粘贴该 JSON，点击“验证并连接”。校验服务器协议与返回的设备 ID 后才保存。无需 OpenClaw 地址和 Token，无需重新编译来绑定设备。
4. 凭据以 Android Keystore AES-GCM 加密，密文保存到应用私有 SQLite；会话、操作回执和便笺按服务器＋设备身份分库。APK 不内置任何密钥。

开发用 USB 只转发**服务器服务**，不是转发 Gateway：

```bash
ssh -N -L 3180:127.0.0.1:3180 YOUR_SERVER_ALIAS
adb reverse tcp:3180 tcp:3180
# 手机连接 http://127.0.0.1:3180 并导入自己的设备凭据
```

USB 是开发调试通道，不是正式产品对 Mac 的依赖。正式安装使用部署者自己的 HTTPS 地址，手机直接访问服务器。仓库不提供公共共享服务器或凭据。

## 交互、语音与可靠性

全屏形象接收本地的 idle / listening / thinking / working / speaking / attention 状态。输入、任务回执、失败与记录由原生界面呈现，人物 WebView 不接触凭据和设备操作。

语音使用 Android `SpeechRecognizer`（优先本机服务，设备不支持时使用系统服务）与 `TextToSpeech`。系统服务商可能在线处理语音／合成文字。点击“说话”会停止旧模型回复与播放，识别完整句子后交给本机 Agent。当前提供显式停止，不承诺全双工、自动开口打断、固定甜妹音色或 Grok 延迟；收音、播报、回声、GPU 和实际手机生命周期待真机验证。

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

公开 APK 使用原创占位形象，不含大肥鱼模型、纹理、派生头像与 Cubism Core。人物半身效果需要自行取得许可允许的素材；私有构建使用 `ANYLINK_CHARACTER_MODE=private`，不得未经授权公开分发。上游 MIT 和素材说明随包保留。

`--test` 覆盖手机自己的真实 HTTP 模型／工具循环、缺失终止事件不执行、身份不匹配、未请求写记忆、跨设备排队、SQLite 重启不重放、凭据不随重定向转发和服务器连接界面。它不等于真机验收。`acceptance.mjs` 已替换为独立手机 Agent 的真实云端联调入口，不通过 Mac Gateway。

旧 `configure-preview.mjs`、旧 Gateway 原生 Talk 适配及其测试已退出产品主线；`android/` HBuilderX 工程只保留作历史原型。不要用旧预览的验收记录证明当前 Android 的真实硬件能力。
