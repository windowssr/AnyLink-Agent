# V0.5 大肥鱼：聊天联动、主动陪伴、漫游与语音

> V0.5 历史说明。当前 V0.6 已移除气泡和右键菜单，采用对话控制及启动动画，见 [V0.6 实施说明](10-conversation-first-companion.md)。

Mac 桌面版本 0.5.0，云端仍为 0.3.0。大肥鱼的名字沿用用户本机 IDENTITY.md，并同步到本机主 Agent 的显示身份。人物设定见 `mac/companion/persona.md`：办事认真利落，闲下来温柔活泼、喜欢在桌面散步，会有分寸地主动关心主人。旧身份文件在首次迁移时备份；后续重新配置不会再次覆盖用户的 Vibe 文件。

## 使用方式

- 正常主助理聊天中的明显情绪，可以由模型调用 `anylink_companion_expression` 选择白名单表情和动作。普通回复还有本地语气映射：开心、庆祝、安慰、好奇和道歉。桌面气泡显示回复摘要，所选中文女声朗读去掉代码与链接后的文本。只跟随当前主聊天，后台其他会话不被朗读。
- 右键“现在聊两句”请求一次真实模型招呼，并显示、播报和保留本机聊天记录。正常主动聊天由本机调度器发起，复用 ywc 的模型代理及记忆上下文。
- 默认每 20–40 分钟择机发起一次主动招呼，每天最多 6 次，连续 2 次未回应后暂停，重新交流后恢复。只在电脑有人使用、主任务空闲时发起；23:00–08:00、离开电脑超过 5 分钟、睡眠、会话锁定、免打扰或语音进行中暂停。唤醒和启动后重新等待，不补发积压消息。
- “自由走动”开启时，闲下来每 40–80 秒择机小范围移动，配合身体、腿部轻摆和上下起伏；手动“走两步”可立即演示。位移限定在当前显示器可见区域，支持负坐标显示器。拖动、操作菜单、讲话和忙碌时停下来。用户拖动的位置单独保存，自动移动不反复覆盖手动锚点。
- 右键可关闭自动招呼、走动或播报，也可“安静陪伴一小时”。“停止说话”、角色正在说话时的单击，以及角色窗口获得焦点后的 Esc 可停声；原生语音面板另有“打断回复”和“结束语音”。
- 工具栏“语音聊天”提供本地实时字幕、说完自动发送、手动立即发送、流式分句播报和开口打断入口。点击开始才收音，结束或关闭语音面板后关闭麦克风。语音输入需要 macOS 26；桌面与声音播放最低 macOS 15。

## 模块与通路

```text
正常聊天 → Mac OpenClaw main
              ├→ ywc 模型代理与云端记忆
              ├→ 可选表情工具（枚举，不执行系统操作）
              └→ 会话生命周期 hooks → 本机短期事件 → 桌面表情、气泡、TTS

本机主动调度器 → 签名 Gateway 客户端 → companion 陪伴会话
                  → 同一云端模型和记忆 → 回复 → 气泡／TTS／嘴型

麦克风 → SpeechAnalyzer → Mac OpenClaw main → 原有工具与模型通路
                  ← Gateway 文本流 ← 分句神经语音合成 → 本机 AEC 播放
```

`CompanionCoordinator` 管理主动策略、窗口位移、投影读取、偏好及生命周期；`CompanionConversation` 通过现有签名 Gateway 协议订阅自己的稳定会话并调用 `chat.send`。`CompanionSpeech` 负责普通聊天／招呼的声音合成和播放、停止及播放状态。Live2D 只接收有限的情绪、说话、走动与方向值，不接收聊天正文、令牌或模型请求。

`VoiceCoordinator`、`VoiceAudio`、`VoiceRecognition` 恢复暂停原型中的 Mac 端实现；没有引入原型中的云端并发或服务改动。原生语音用独立音频所有权、流式句子缓冲、转写时间水位及音频 epoch，拒绝打断后的迟到数据；通过同一个 voice-processing AVAudioEngine 输入和播放，提供 AEC 播放参考。系统合成器重复发出的结束 PCM 回调只计数一次。原始音频不落盘、不上传；文字会进入正常本机 OpenClaw 会话。

嘴型以实际播放状态驱动基础开合，停止后闭嘴；当前没有逐音素口型或角色专属克隆声线。走动采用窗口位移与已有身体／腿部参数，未包含另行制作的完整行走动作文件。

## 活泼甜妹声音

用户试听并明确选择 A 后，本机默认配置为 `sweet-lively`：微软 `zh-CN-XiaoyiNeural`，语速 `+8%`、音高 `+3Hz`。另有 `sweet-warm`（Xiaoxiao，`+5%`、`+2Hz`）。人物措辞也偏轻快、有笑意，避免客服播音腔和过量语气词。这是预设神经女声，并非大肥鱼原作者的配音或克隆。

`NeuralSpeech` 读取私有的 `data/mac/voice/neural.json`，必须同时具有 `enabled:true`、`consent_microsoft:true`、有效白名单 profile 才调用在线服务。用户同意后，待播报的回复文本发送给微软 Read Aloud 服务；DeepSeek、记忆及原始麦克风音频的通路保持原样。没有新增 Azure Key。适配器依赖固定版本 `edge-tts==7.3.1`，通过带哈希锁的 Python 环境安装，不打入应用包。这个社区适配器不提供 Azure 正式 API 的服务承诺。

普通聊天／招呼用 AVAudioPlayer 播放 MP3；实时语音先把每段 MP3 解码成 PCM，再送入原有 AVAudioPlayerNode，保留同一 voice-processing engine 的回声消除参考。只有实际开始播放才张嘴。取消会停止播放器、取消排队句子并终止正在合成的 Python 子进程；epoch 检查拒绝迟到的音频。新一轮开口也会取消还没播出的合成任务。已启用在线声线时，服务失败只显示文字提示，不自动换回系统机器音。

输入通过进程私有管道传递，正文不放在命令参数或诊断日志。每段最多 1,400 字、音频最多 1 MiB、30 秒截止；合成结果在内存中传递。语音聊天解码时短暂写入 0700 目录下的 0600 合成 MP3，读完立即删除；此目录不会保存原始麦克风数据。意外进程崩溃可能留下尚未来得及删除的合成片段，运行数据目录整体排除在 Git 和源码发布包之外。

```bash
npm run desktop:voice:install
# 仅在理解并同意将待播报文字发送给微软后执行：
node mac/voice/select.mjs sweet-lively --consent-microsoft
# 换另一个已试听声线：
node mac/voice/select.mjs sweet-warm --consent-microsoft
# 撤回在线合成；系统语音可另在右键菜单关闭：
node mac/voice/select.mjs off
```

切换后先停止当前播报，新请求读取新选择；重开语音面板／应用可更新面板说明。右键“语音播报 · 活泼甜妹”只切换普通聊天和招呼的朗读，语音聊天由其面板单独控制。声音仍受网络合成耗时影响，不能宣称零延迟。

## 本机插件与边界

`anylink-companion` 是一个本地插件，使用官方 `before_prompt_build`、`llm_output`、`agent_end`、`before_tool_call` hooks。共用人物设定在系统上下文补充，普通聊天保留主 Agent 工具策略。只有明显情绪才需要模型调用表情工具，不为每个表情单独调用另一模型。

主动招呼的 `companion` 是同一台 Mac、同一个 OpenClaw Gateway 中的受限会话配置，允许工具只有 `anylink_companion_expression`。配置 allowlist、`toolsAllow` 和 `before_tool_call` 均限制此范围。它读取共享记忆上下文，但不能执行命令、操作软件、发外部消息或写记忆。正常助理任务继续通过主会话进行。没有云端陪伴 Agent，没有外部消息频道或 Codex 定时自动化。

插件只在桌面应用签发的短期可见租约有效时写投影。事件保存在 `data/mac/companion/events`，0600 权限，最多约 64 条、两分钟过期；只包含需要展示的截断文字和枚举，不复制完整历史。隐藏／退出会禁用租约并清理事件。主会话通过稳定路由 UUID 或运行 ID 关联，避免把会话 incarnation ID 当作路由 ID；新建页面等待路由完成后再处理当前回合。启动以前的事件不会播放，其他消息频道不会进入桌面播报。原生记录入口使用官方 `chat/<agent>/~key/...` 完整 key 路径，避免旧命名空间产生同 UUID 短路由冲突。

主动请求在提交前持久记录尝试时间、提交标识与状态，使用 Gateway 幂等键及实际 run ID。连接结果未知时显示待确认，不自动重发；重启保留未知状态。取消只针对自己拥有的 run，保留其他会话和 side runs。状态读取客户端仍只有 `operator.read`；聊天客户端按原生配对使用聊天读写作用域，方法有明确白名单。令牌始终留在原生进程，不进入 Live2D。

## 安装、验证与回退

```bash
npm run desktop:companion:install
npm run desktop:companion:configure
node mac/cli.mjs config validate
npm run test:companion
npm run desktop:build
# 先退出窗口应用；本机 Agent 可保持运行
npm run desktop:install
```

配置脚本只修改当前独立 Mac profile，采用已安装版本的 `agents.entries`、显式 owner 和原有主 Agent；保留凭据、模型、并发上限 1、现有电脑控制权限及云端数据。配置变动按 OpenClaw 热重载机制生效。仍用固定的 OpenClaw 2026.11.6，不修改其核心代码。

验证包含：本机插件租约／过期／频道边界、受限陪伴工具、聊天语气清洗；Swift 主动策略、移动边界与转写／播放所有权；真实签名 Gateway 聊天与取消结果协调；GUI 聊天 → 表情工具 → 桌面动作与播报、窗口实际位移、原生麦克风开始／结束。源代码、安装包及日志须检查凭据，人物模型与 Core 继续只留在本机。

回退先退出窗口应用，用安装器保存的 `.AnyLink.previous-*.app` 恢复旧壳；没有云端数据库迁移。旧壳不签发可见租约，因此新投影不会继续记录。若还需撤回人设，可检查 `IDENTITY.md.before-desktop-companion`、`SOUL.md.before-desktop-companion` 后按需要恢复，不覆盖用户后续改名和事实。无需删除会话、模型、工作区或云端记忆。

接口依据：[OpenClaw 插件 hooks](https://docs.openclaw.ai/plugins/hooks)、[会话与提示 hooks](https://docs.openclaw.ai/plugins/hooks/prompt-and-session)、[多 Agent 配置](https://docs.openclaw.ai/concepts/multi-agent)、[Apple AVSpeechSynthesizer](https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer)、[edge-tts 适配器](https://github.com/rany2/edge-tts)。

## 本机验收记录（2026-11-22）

- TypeScript 检查通过；伙伴 Node 测试 5 项、Swift 行为检查 18 项、语音所有权／结束回调／字幕边界检查 11 项通过。合成输入校验 4 项在离线 mock 下拒绝空文本、超长文本、未知声线和错误类型，均未触及网络。
- 真人声线选择：用户试听后选 A，并明确同意待播报文字发往微软。真实神经合成与 MP3 解码成功；短测试句一次完整合成耗时约 4.5 秒、音频约 4.4 秒。正在生成的独立测试语音在取消后约 68 毫秒结束进程；这不是端到端对话延迟或物理扬声器停声测量。
- GUI“摸摸头”和“现在聊两句”均触发所选 `sweet-lively`，采样观察到实际播放状态，结束后恢复非播放。陪伴招呼经本机 OpenClaw → ywc → DeepSeek 完成，未写记忆或执行系统任务。
- 主聊天中的表情工具真实选择 `happy + wave`，桌面消费对应回复并播报。真实窗口位移观察到 63 个走动采样帧、4 个不同横坐标。
- 原生中文识别用不保存音频的合成输入 fixture 识别 15 字；GUI 麦克风开始／结束状态已验证。真实 Gateway 首段文字一次约 2.35 秒；取消请求响应曾为 12 毫秒，但该回合在取消前已结束，不据此宣称运行中的模型取消延迟。仍需用户实际开口评估收音、口音和扬声器环境下的连续打断体验。
- 完整会话 key 的官方 session-entry 只读探测返回 204，消除旧 namespace 同短 ID 导致的记录冲突。没有新增云端发布或数据库迁移；云端仍为 V0.3.0。

验收产物保存在被忽略的 `artifacts/`：`neural-speech-acceptance.json`、`neural-gui-playback.json`、`neural-proactive-playback.json`、`companion-behavior-observation.json`、`voice/gateway-acceptance.json` 及凭据扫描报告。它们不包含真实语音原始录音；发布只提交代码、锁文件和说明。
