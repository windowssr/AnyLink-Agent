# 大肥鱼 Android 原生预览

基于官方 OpenClaw Android `v2026.11.6`，固定上游提交 `06afb10d3272cc9deaf38ca6a3b7b839d5935638`。这是 AnyLink 开源参考客户端，不是官方发行包。公开版本默认不带第三方模型、纹理、派生头像或 Cubism Core，使用原创占位形象；下文半身人物效果需要自行配置并仅用于许可允许的私有构建。手机要求 Android 12 / API 31 或更新。

主入口是占满屏幕的正常比例半身人物。底部开启语音；文字、文件、工具结果与审批按需展开官方聊天界面。聊天、语音、手机节点与工具生命周期继续由官方原生代码管理；人物 WebView 只接收表现状态。

## 当前通路

```text
Android 原生 App：人物 + 官方 Talk / Chat + 获准的手机节点工具
    ↔ 受保护连接 → Mac OpenClaw Gateway：会话与 Agent 工具循环
        ├─ ywc 模型代理 → DeepSeek Flash
        ├─ ywc 统一记忆 → global + 所选逻辑设备事实
        ├─ Mac 只读文件名搜索
        └─ 配对后的手机节点 → 原生权限范围内的执行回执
```

使用时 Mac 必须在线。云端不托管这段 Agent 会话。当前配置 `anylink-android-preview` 对应已授权的“Android 开发预览（未绑定真机）”凭据；它不等于手机已完成配对。APK 不包含模型密钥、云设备令牌、Mac Gateway 令牌或配对秘密。

语音采用手机系统 SpeechRecognizer → 同一 DeepSeek Agent → Gateway `talk.speak` → 原生播放器。微软在线神经语音为 `zh-CN-XiaoyiNeural`，语速 `+8%`、音调 `+3Hz`。原生 Talk 负责播放、监听、打断与取消；未接入另一套语音模型。识别服务的可用性和中文能力取决于手机；开口打断、回声和实际延迟仍需真机验证。人物嘴型目前反映播报状态，不是音素级唇形同步。

## 电脑形象预览

```bash
node android-native/scripts/preview.mjs
```

打开 <http://127.0.0.1:5181/>。预览只演示构图、倾听、思考、工作、播报和等待处理等表现，不访问麦克风、不调用模型、不执行任务。与原 uni-app 预览的 5180 端口分开。

## 准备与构建

本机使用已有 Homebrew JDK 17 和固定 Mac OpenClaw Node 24 依赖，不安装 Android Studio 或模拟器。SDK、Gradle、官方稀疏源码及缓存都在忽略的 `data/android-native/`。Google SDK 许可已经由主人于 2026-11-22 明确同意；换使用者或环境时须自行阅读并接受许可。

```bash
node android-native/scripts/install-toolchain.mjs --accept-sdk-license
node android-native/scripts/install-gradle.mjs
npm ci --prefix android-native/renderer --ignore-scripts --cache data/android-native/npm-cache
node android-native/scripts/prepare.mjs
node --test android-native/tests/*.test.mjs mac/plugin/device-context.test.mjs
node android-native/scripts/build.mjs --test
node android-native/scripts/build.mjs
node android-native/scripts/inspect-apk.mjs
```

上游 compileSdk=37、targetSdk=36、minSdk=31；Google 仓库的平台包现名为 `platforms;android-37.0`。工具锁定见 `toolchain-lock.json`；下载校验失败不会执行。`install-gradle` 使用与官方 wrapper 相同的版本及 SHA-256，为低速连接提供可恢复的分段下载。官方代码准备脚本验证完整上游 SHA，以固定上下文打补丁，遇到其他本地修改会停止，避免重置覆盖。

当前 APK 目标：`artifacts/android-native/AnyLink-Android-0.2.0-preview.2.apk`。使用独立 applicationId `com.anylink.agent.debug` 和本机调试签名，可与官方 App 并存。未签发布版、未上传商店；后续正式签名需要稳定的私有密钥。公开构建不携带受限素材；私有本机构建可使用 ANYLINK_CHARACTER_MODE=private，分发与商业用途须另行核实角色及模型授权，详见原有 `mac/companion/ASSET-NOTICE.md`。

官方原生图表资源仍使用上游 Vite 8.3.4、Pele 1.6.0 和 DOMPurify 3.4.17，通过独立 npm lockfile 构建。Gradle 仅替换该构建命令的入口，不改渲染器、沙箱和清理逻辑。JVM 回归的 Maven 缓存和 Java 用户目录也限制在项目 `data/android-native/`。测试固定使用 Robolectric 4.17 的 Android 14 / API 34 框架 JAR，预取约 151 MB，并校验 Maven 发布的 SHA-256；这不安装或启动模拟器，也不改变 App 的 Android 12 最低要求。

`prepare.mjs` 复用已安装且版本核对一致的 `esbuild` / `typebox` 运行官方协议和本地化生成器；首次全新电脑需先按 Mac 工程说明安装固定运行时及私有人物资源。

## 配置与接入

```bash
node android-native/scripts/configure-preview.mjs
# 生成忽略的 openclaw-proposed.json，先使用正式 CLI 校验
node android-native/scripts/configure-preview.mjs --apply
```

该脚本只更新本项目 Mac profile，首次应用前保留 `data/android-native/openclaw.before-native-preview.json`。不开放公网端口，不改变 Mac 默认 Agent、不改变现有桌宠开关。Gateway 仍监听 `127.0.0.1:18791`。配置改变由 Gateway 正式热重载接收。

真机随后接入：USB 调试 → `adb reverse tcp:18791 tcp:18791` → 官方连接界面填本机转发入口 → 由主人完成所需配对与系统权限。连接令牌只在本机操作，不写进文档或 APK。无线连接另行配置可信隧道与 TLS，不能直接公开当前回环 Gateway。辅助功能、屏幕捕获等由手机系统授权，安装 App 不等于权限已开启。

真实手机应建立自己的逻辑设备凭据并配置对应 Agent，重新用 `ANYLINK_AGENT_ID=<配置的手机 Agent ID>` 构建；不能把预览身份直接称为已认证的物理手机。Agent 到云凭据的映射由宿主配置，切换该 Agent 的 Mac 客户端也会进入同一逻辑上下文；这不是基于输入来源的权限证明。

## 验证与回退

`node android-native/scripts/acceptance.mjs` 通过本机 Gateway 验证真实模型、只读搜索、明确写记忆、新会话召回和官方语音合成。脚本仅创建唯一标记的验收事实并在结束时软删除，保留既有审计，不修改主人事实；报告和音频在忽略的 `artifacts/android-native/`。这不能代替真机语音、GPU、节点操作与后台测试。

预览配置回退：先确认没有正在执行的任务，再将上面的首次备份复制回 `data/mac/openclaw/openclaw.json`，使用正式 CLI 校验，等待热重载。不要清空 Mac 状态、会话、云记忆或数据库。关闭原生预览不会影响旧 uni-app 工程，`android/` 保留为历史参考，后续 Android 主线在本目录。

本次环境的 Maven Central 主端点返回了要求约24小时后重试的 HTTP429。构建使用 [Google 官方 Maven Central 镜像](https://docs.cloud.google.com/docs/buildpacks/java#google_cloud_hosted_maven_central_mirror)，包版本保持上游固定值，JVM 框架与 POM 仍校验相同发布 SHA-256。下载器遇到限流会停止该端点的重试并保留已有分段。
