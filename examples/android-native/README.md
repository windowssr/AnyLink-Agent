# Android 端参考客户端（原生独立 Agent · 大肥鱼）

> 本目录属于 `examples/` 展示实例，与核心协议（`protocol/`）、云端中枢（`server/`）和 SDK（`sdk/`、`sdk-python/`、`mcp/`）完全隔离。

Android 客户端直接在手机本地运行完整的 Agent 会话、工具循环与 SQLite 幂等账本，**不依赖 Mac 在线或任何 Gateway**；仅在需要操作电脑时通过 AnyLink 云端 Protocol v3 与 Mac 实时联动。

---

## 一、核心特性与前端架构

- **独立形象舞台 + 完整可滚动对话流**：
  - 顶部为独立无遮挡的虚拟形象舞台（支持点击「收起/展开形象」，弹起输入法时自动紧凑化）；首帧即展示带呼吸动效的原生头像，Live2D 就绪后平滑淡入，杜绝白屏或卡死文字。
  - 中部为完整可滚动的多轮对话气泡流（支持流式输出、长文选择复制、工具调用标签、实时跨设备回执卡片与快捷提问芯片）。
- **极简登录验证**：
  - 只需填写 **HTTPS 服务器地址** 与 **预设登录密码（或加入密钥）** 即可一键接入，自动签发并加密保存专属设备令牌（Android Keystore AES-GCM），密码绝不落盘。
  - 展开「高级选项」可自定义设备名称、唯一短别名 `slug`（如 `my-phone`）或导入旧版凭据 JSON。
- **后台保活与轻量化悬浮球**：
  - 连接成功后自动拉起常驻前台服务 `AnyLinkCompanionService`（不强依赖悬浮窗权限），退到后台也能保持 `/edge/v1/ws` WebSocket 实时在线与断线自动重连。
  - 开启悬浮窗权限后，退到后台会自动显示轻量化原生大肥鱼悬浮球（点按说话、长按回 App、拖动换位、拖至底部 `×` 隐藏），低内存、零后台 WebGL 崩溃风险。
- **跨设备联动 + 主动语音汇报**：
  - 支持免能力表 `task_invoke`（如 `@home-mac`）、`task_create`、`link_directory`，Mac 完成任务或拒绝（`declined`）后会通过 WebSocket 实时推回并显示在对话流、同时语音播报。
  - 可选开启无障碍服务（`AnyLinkAccessibilityService`），让手机大肥鱼本机读屏、点按、输入、滚动与打开应用（控屏工具仅限本机对话，不对外暴露为远程能力）。

---

## 二、数据通路（Protocol v3）

```text
Android 原生界面（形象舞台 + 完整对话流 + 语音）
  → 本机 DeviceAgent（会话 / 工具循环 / SQLite 幂等账本）
    → AnyLink Cloud Hub (HTTPS + WSS /edge/v1/ws)
      ├── 云端记忆大脑：/edge/v1/memory/assemble & /edge/v1/memory/ingest
      ├── 多模型网关：/model/v1/chat/completions (SSE) & /model/v1/speech
      └── 跨设备实时总线：/edge/v1/tasks + /edge/v1/ws 推送
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
data/android-native/sdk/platform-tools/adb install -r artifacts/android-native/AnyLink-Android-0.5.0-preview.1-private.apk
```

---

## 四、真机使用与后台保活配置

1. 打开 App，填写 **HTTPS 服务器地址**（例如 `https://your-server`）和 **登录密码 / 加入密钥**，点击「验证并连接」。
2. 顶栏出现绿点 `Protocol v3 · WS 实时在线` 即连接成功。
3. 点击顶栏「**后台**」：
   - **通知权限**：建议开启，保持前台保活通知正常显示。
   - **电池优化**：强烈建议在国产 ROM（小米/华为/OPPO/vivo/荣耀等）里设为「无限制 / 允许后台高耗电」，避免锁屏或隐藏后被系统强杀。
   - **悬浮权限**（可选）：开启后切后台出现轻量化悬浮球。
   - **无障碍权限**（可选）：开启后可语音或文字让大肥鱼自动操作手机 App（Android 13+ 侧载包需先在「应用信息」右上角允许「受限设置」）。
