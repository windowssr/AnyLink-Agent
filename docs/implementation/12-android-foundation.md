# Android V0.1：本地 Agent、HBuilderX 工程和电脑预览

修订：2026-11-22。交付范围依主人选择为“先做工程和电脑预览，稍后再连手机”。Mac 和 ywc 现有部署不改动。

## 架构

```text
手机 uni-app 界面 / App 内大肥鱼
  → 手机 Pi Agent：会话、提示词、工具循环、取消、本地执行账本
      → ywc /model/v1/chat/completions → DeepSeek Flash
      → ywc /edge/v1/* → global / device 记忆
      → Android 本机状态、AnyLink 私有便笺、形象表现请求
```

Mac 继续运行 OpenClaw 2026.11.6。官方 Android App 是 companion node，不在手机托管 Gateway，不能直接视为完整手机 Agent。因此 Android 选用固定的 Pi Agent core 1.6.0，在本机 JavaScript 服务环境执行成熟的工具循环，不自行重写 Agent loop，不把会话运行放到服务器。OpenClaw 的整体配置、插件及技能不会自动在 Android 上完整运行。

依据：[OpenClaw Android 定位](https://docs.openclaw.ai/android)、[Pi Agent 源码](https://github.com/earendil-works/pi/tree/main/packages/agent)。本轮已用安装的 1.6.0 类型声明与实测事件流核对接口，未仅依据旧 README。

## 模块与通路

- `android/core/agent.mjs`：单一大肥鱼人格，每次用户输入读取当前有效云端事实，组装本机历史与工具；每轮最多 6 次模型请求，到上限留下等待用户继续的边界。
- `core/model.mjs` 与 `protocol.mjs`：OpenAI-compatible 消息、工具声明和工具结果转换，SSE 事件边界拼接；完整 `[DONE]` 和结束原因确认后才允许执行工具。未知请求不自动重试。
- `core/journal.mjs`：手机会话和运行、工具请求、结果回执。副作用前持久化 `submitted`，恢复后变成 `submission_unknown`；相同调用编号不得重复执行或更换参数。取消不宣称撤销已经完成的操作。
- `core/tools.mjs`：云端记忆工具，设备来源由服务端凭据绑定，device 保存限当前手机；写记忆需当前用户明确提出，否定指令不授予写入。更正与删除传 revision，写请求使用稳定幂等键。基础本机工具包括设备状态与私有便笺。
- `runtime/transport.mjs`：Android 使用 HTML5+ 原生 XHR，电脑预览使用 fetch，二者向同一 SSE 解析器提供文本；实际逐段到达与延迟仍需真机验证。HTTPS 或开发回环地址之外拒绝传输凭据。
- `runtime/vault.mjs`：Android Keystore AES-GCM 保护服务凭据，失败不降级明文。H5 只用内存连接信息。原生桥接尚未进行硬件验收。
- `components/CompanionStage.vue`：renderjs 中加载本地 Live2D，隔离于模型凭据和聊天正文；仅接收情绪、动作、暂停等表现状态。页面尺寸变化重新适配；后台暂停渲染。未就绪时保留本机人物头像。
- `pages/index/index.vue`：单一聊天入口、工具步骤回执、停止与新对话，没有第二个“桌面伙伴” Agent 选择。首次连接是设备身份导入。界面包含基础文字聊天，语音不在本阶段交付。

编译生成的 Agent 浏览器运行库约 78 KB（独立 Pi 核心，未压缩 App 整体体积），固定 npm lockfile；人物和 Core 使用已有私有素材，不加入 Git。

## 电脑预览与云端验收边界

预览服务只监听 `127.0.0.1:5180`。本地演示以确定性适配器代替模型，界面明确显示“演示预览 · 未调用模型”，会话与便笺使用独立命名空间，不假装读取了 Android 真机或云端记忆。

真实连接使用独立 Android 预览设备凭据。初次签发曾因授权范围未明确被自动审批拒绝；2026-11-22 主人明确选择“允许，继续验证真实模型和记忆”后，已创建“Android 开发预览（未绑定真机）”逻辑设备并完成验收。Android 的模型与写记忆请求均使用自己的凭据，没有借用 Mac 身份。Mac 身份仅用于读取 Mac 自身上下文，证明共享事实与设备事实的选择正确。

已有 Mac 的 `127.0.0.1:3181` SSH 隧道承载开发连接，不修改云端 origin、端口、权限或架构。预览同源代理仅转发标准模型 / 记忆 API，不运行工具循环。独立凭据及其他设备令牌均排除在源码和构建包之外。当前预览页刷新时通过受保护的同源引导自动连接真实服务。

## 本轮验证

- HBuilderX 5.34 自带 uni-app Vue 3 编译器完成 Web 和 Android App 资源编译，检查完整页面资源与 `app-service.js`、`app-renderjs.js` 等原生资源输出。
- 本地 12 项测试覆盖真实 Pi 工具多轮、回执持久化与去重、SSE 任意分块、取消、截断流禁止执行、云记忆写入意图、device 作用域和幂等键、重启后未知状态、协议调用编号、轮数上限，以及未知写入立即结束工具循环。
- 额外使用无 `process`、`Buffer`、`require`、DOM 和 Node 内建模块的隔离 JavaScript 环境验证打包后的 Pi 完整工具回路；兼容补丁包含取消信号、时钟及 JSON 工具参数复制。它验证运行库的可移植性，不替代 Android 硬件测试。
- 本地 HTTP 核对入口和模型资源可读，同源引导成功解析到独立 Android 设备，拒绝跨站访问；凭据文件权限为 0600。
- 自动化界面工具连接超时，本轮未完成浏览器可视验收，人物的手机 GPU / WebView 表现也没有硬件验证。预览地址已交付供查看，不将构建成功算作真机运行成功。

AppID 留空，当前没有签名 APK、真实手机绑定或安装。`build:app` 只生成可供 HBuilderX 原生打包使用的资源。真机阶段再配置真实 DCloud AppID、签名、连接入口并逐项验证。

## 真实云端验收（2026-11-22）

命令为 `npm run test:live` 与 `npm run test:memory:live`。结果记录在忽略的 `artifacts/android-live-acceptance.json` 和 `android-memory-acceptance.json`，不保存密钥或既有主人事实正文。

- 真实 DeepSeek Flash 经 ywc 返回流式响应，Pi 在电脑端完成状态读取、便笺保存和结果回传：3 次模型调用，2 个工具成功，1 条验收便笺。
- 记忆验收的 6 个 Agent 会话轮次全部完成，合计 15 次模型请求、567 次非空文本增量；探针整体耗时约 41.3 秒，首段文本约 4.5 秒。这是一次电脑经 SSH 隧道的功能验收测量，不代表手机端或语音延迟。
- Agent 实际调用云端记忆工具创建全局事实；全新本地会话可查询召回，Mac 自身当前全局上下文也能读到相同事实。
- Agent 查询后更正，revision 从 1 变为 2；旧 revision 的写入被拒绝，新会话召回新内容。
- Android 设备事实进入其自身 device 上下文，没有进入 Mac 的 device 上下文；同一幂等写请求重复提交返回同一事实 ID。
- Agent 实际调用删除工具；Android 查询与 Mac 全局上下文均不再返回已删事实。删除后再开会话调用查询，也没有返回旧事实。
- 验收写入限制为唯一标记且来源为该预览设备的测试事实；结束时通过记忆 API 软删除，活动记忆中无测试残留，修订审计按既有设计保留。未更改主人的既有记忆。

真实云端链路已通过，实际 Android 手机、原生 Keystore / XHR / GPU / 后台行为仍待真机验收。

## 后续顺序

1. 真机基础闭环：安全存储、SSE、停止、便笺、状态回传、进程恢复、统一记忆新会话召回与 revision。
2. App 内语音和形象性能；角色动作和回复一致，验证实际首字 / 首音延迟。
3. 原生悬浮形象和通知，明确 Android 前台服务、锁屏和省电限制。
4. 无障碍跨 App 操作，以及通用 Mac 协作。只读文件名搜索已在电脑预览与真实 Mac 间完成，见 [跨设备搜索](13-peer-file-search.md)；不计为真机联网或通用电脑操作。

入口和命令见 [Android 工程 README](../../android/README.md)。所有验收按层记录，电脑预览、App 资源编译、真实模型链路、签名 APK 和真机操作分别计入。
