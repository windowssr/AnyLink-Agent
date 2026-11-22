# Android 原生伙伴：官方框架适配

日期：2026-11-22。主人确认 Android 12+，授权使用官方 Android companion，后续再连手机；Google SDK 许可已明确接受。

## 实现边界

Android 主线从 uni-app / Pi 实验工程转为官方 OpenClaw Android 原生工程。保留官方 ChatController、TalkModeManager、GatewaySession、设备签名与配对、权限、节点工具和取消逻辑。Mac 是 Gateway 与 Agent 宿主；ywc 继续只做统一记忆和模型代理。手机拥有本机界面和执行能力，本阶段不把完整 Gateway 移植到 Android。

## 界面与表现

默认进入占满屏幕的正常比例半身人物，以语音按钮为主入口，文字输入和真实结果是按需展开的同一聊天界面。原有分享、助手指令和待审草稿会自动展开输入界面；普通点人物不会切到完整聊天窗口。

原生状态直接投影为 idle、listening、thinking、working、speaking、attention。任务中的工具活动、等待用户问题和错误来自真实会话；模型可请求白名单情绪和动作，但表现请求不证明任务成功。手机表达不会发给 Mac 桌宠，也不虚构渲染确认。

人物用本地 WebViewAssetLoader 加载；没有 JavascriptInterface、麦克风接口、聊天文本、令牌或外部网络。Activity 后台时暂停，减少动态效果时降低动作。半身构图与状态在电脑浏览器预览中经过检查；这不等于 Android GPU / WebView 已验收。

## 语音会话所有权

采用官方 native Talk 的 stt-tts 路线，不要求另一家实时语音模型账号。显式的 nativeSpeech 入口跳过实时模型目录的配置提示，麦克风权限和运行时校验保留。

官方 Chat 与 Talk 的默认会话选择存在差别。适配层在实际启动监听时进入运行时拥有的操作，核对连接、前台、权限和配置的 Agent，退休过时选择，将可见 Chat 和 Talk 一起选择到该 Android 节点主会话；权限弹窗返回也走同一操作。仍使用官方语音生命周期，避免 UI 显示手机会话而语音发往 Mac 主会话。首次启动或主动切换后会显示实际用于语音的主会话，不能假称在原历史分支继续。

Microsoft 在线语音沿用已确认的 Xiaoyi 活泼配置。TTS 自动发送设为 off，由原生 Talk 请求 `talk.speak` 并播放，避免在现有 Mac 播报之外再加自动语音附件。现阶段不是端到端实时语音，不能承诺 Grok 式零延迟。

## 记忆路由

宿主为 exact agentId 配置独立 `connectionFile`。每个 Agent run 捕获自身路由，读取并核对 `/edge/v1/context` 的 device_id；手机默认获取全局与自身设备事实。设备记忆保存强制为该 UUID，不允许模型参数换成 Mac UUID。更新、删除仍由云服务认证、revision 和幂等键约束。

缺少、撤销或不匹配的手机连接降级为全局只读，不借用 Mac 凭据写入。原生 node 会话未配置时同样不能继承 Mac 设备事实。宿主的主 Agent 保留现有跨设备查询能力。长时事实不会重复写入本地 MEMORY.md。

这是逻辑上下文路由，不是物理输入设备认证：在 Mac 上显式选中该 Agent 也会获得同一逻辑上下文。预览 Agent 只对应此前已授权的开发设备，尚未完成手机可信绑定。后续可信设备输入路由需要在 Gateway 正式鉴权边界接入，不能拿会话前缀当签名证明。

## 可重复施工与验收

源码、工具链锁定，官方源保留在忽略的稀疏 checkout，业务差异集中在 `android-native/overlay` 和确定性准备脚本，不维护整个上游仓库副本。私有模型与 Core 从现有本机资源复制到 APK；凭据不复制。应用包使用 AnyLink 独立 applicationId、蓝色形象与调试签名。

Node 回归覆盖设备记忆并发隔离、无效身份退化、否定写入意图、revision、幂等与未知写入；原生回归覆盖表现优先级、native Talk 启动、权限异步返回后的会话选择，以及分享/助手草稿自动展开。工程构建、JVM 测试、电脑预览、真实云端调用、APK 和真机验证分别记录，不相互替代。

施工命令、APK 路径、连接方法与回退见 [原生工程说明](../../android-native/README.md)。旧 [uni-app 实验记录](12-android-foundation.md) 为历史记录，后续开发不再继续其独立 Agent / 语音回路。

## 2026-11-22 联调记录

22 项 Node 测试已通过，包括 10 项设备记忆路由、5 项伙伴行为、2 项配置隔离、3 项已中断下载恢复/校验与仓库限流和 2 项既有记忆插件测试。正式 OpenClaw 配置校验无警告，Mac profile 通过官方热重载接收，未开放新网络入口。

真实 DeepSeek 联调通过 Android 逻辑身份、流式回复、Mac 只读搜索工具回执、Android 来源的 global/device 保存和新会话召回共 5 项检查。验收事实结束时全部软删除，活动测试记忆剩余 0。4 个模型轮次总时长分别约 11.8、13.5、25.1、5.3 秒；这些是电脑经隧道的功能测量，包含多轮工具调用，不能当成手机首音延迟。

首轮语音联调发现该固定 Gateway 必须显式配置 `talk.provider`，仅配置共享 TTS 不足以启动 `talk.speak`。配置修正后独立复测通过，正式回执 provider=microsoft，返回 audio/mpeg、23,616 字节。一次短句合成约 5.4 秒；未验证手机端收音、回声和开口打断，也不承诺零延迟。

电脑视觉验收检查了 390×844 视口的半身构图、倾听/思考/工作/播报等状态和文字/结果展开。原生 Kotlin 编译、JVM 回归、APK 检查与硬件验证单独记录，不以这个浏览器预览代替。

手机工具配置额外检查了上游策略：coding profile 默认不含 nodes / mobile_ui，因此仅为 Android Agent 设置显式 profile 与 9 项工具白名单，Mac 的 coding profile 和全局禁止项保留。真实 Agent 已调用 nodes.status，收到空节点列表并如实报告未连接手机，未申请配对/权限、未执行手机操作。

Google SDK、Gradle 和必需构建工具已安装在项目目录，没有安装 Android Studio 或模拟器。原生 Kotlin / Java 严格编译通过，10 项 JVM 回归全部通过、无跳过：3 项表现与问题作用域、4 项 native Talk / 权限返回会话绑定、3 项分享 / 助手输入 / 当前问题展开。界面测试使用官方 CompletedWork 场景，保留真实 ChatScreen、ViewModel 与 Gateway 问题事件；结果和 JUnit 原始报告保存在 `artifacts/android-native/native-tests.json`、`artifacts/android-native/junit/`。

预览版本为 `0.2.0-preview.1`，安装包使用独立包名 `com.anylink.agent.debug`，保留官方 `ai.openclaw.app.MainActivity` 启动入口。APK 检查脚本核对最低 / 目标系统、应用名称、调试签名、完整源码提交、人物资源和解压后的凭据扫描，结果写入 `artifacts/android-native/apk-inspection.json`。电脑上的 JVM / 构图与网关联调不代替手机安装、WebView GPU、麦克风、播放、打断、后台和节点操作验收。
