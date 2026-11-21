# V0.4 Mac 蓝色大肥鱼桌面伙伴

本页保留 V0.4 的实现与验收。V0.5 已扩展聊天表情动作、主动招呼、桌面漫游和本地语音，当前使用方式见[伙伴行为与语音](09-companion-behavior-and-voice.md)。

桌面应用版本 0.4.0，云端保持 0.3.0。该阶段只增加 Mac 表现层；Mac 的 OpenClaw 继续负责会话、工具循环和执行结果，ywc 继续只负责统一记忆与模型代理。语音暂停，原型保留在本地 `wip/voice-paused` 分支，不包含在本版。

## 使用

打开 `~/Applications/AnyLink.app`，桌面默认显示正常比例的蓝色大肥鱼 Live2D 人物。角色随系统跨桌面显示，透明区域允许点击下方软件。拖动人物或气泡可移动，位置和大小保存在本机。双击角色或单击气泡打开原来的本地聊天窗口。

单击角色举手打招呼；右键菜单支持举手、竖起手指和点头。举手与竖手指使用素材已提供的动作，点头通过已有头部参数生成。动作回到待机，头发与尾巴使用模型物理效果。系统开启“减少动态效果”时停止动态播放。菜单也提供小、标准、大尺寸、移回屏幕右下角、隐藏和来源说明。工具栏或菜单中的“定位桌面伙伴”可恢复显示。隐藏或退出应用会关闭角色渲染与状态轮询，后台 Agent 保持运行。

气泡显示待命、排队、忙碌、需要查看、连接中或本轮结束。结束只表示活跃运行消失，不声称任务成功，也不推断聊天内容。详细结果仍由原聊天页面展示。未接语音，不启用麦克风、口型或声音。

## 本地通路

```text
Mac NSPanel（浮动、透明、拖动、菜单、气泡）
    ├── WKWebView → PixiJS → pixi-live2d-display → 私有本地模型与 Core
    │                 ↑ 临时 127.0.0.1 静态资源服务
    └── 签名只读 Gateway 客户端 → sessions.list → 状态枚举与活跃数量

原聊天窗口 → Mac OpenClaw → 原有工具／ywc 记忆和模型代理
```

`CompanionCoordinator` 管理位置、缩放、生命周期与每 4 秒一次的状态投影；`CompanionView` 保留原生点击、拖拽、无障碍按钮及透明命中；`CompanionRenderer` 管理 WKWebView、资源子进程及有限状态桥。WebGL 以最高 24 FPS 渲染，每次只采样自己画布的一个 alpha 像素，判断透明区域，既不截图桌面，也不保留鼠标轨迹。

`LocalGatewayClient` 使用独立 Ed25519 设备身份签名，唯一作用域为 `operator.read`，方法白名单为 `connect` 与 `sessions.list`。不取聊天消息正文、不发起任务、不调用模型。服务只处理 `agentId:main` 的活跃状态，兼容 sidebar 返回的 sharedFacts；忽略历史终态和过期 attention。连接失败显示离线，不影响本地 Agent。

临时 Node 静态服务只监听 127.0.0.1 随机端口，以独立随机路径限制资源访问；不是 Gateway 代理。只允许 GET/HEAD、限定三个实际资源根目录，拒绝目录列表、越界和符号链接逃逸；没有命令、写入或模型接口。父应用关闭 stdin 或退出时结束。Gateway／云端凭据从不进入角色 JavaScript。WKWebView 使用临时数据存储，拒绝导航到其他地址；CSP 限制外部资源和媒体。

## 素材与安装

人物选用社区存档 `YJackie-Li/DeepSeek-chan` 的蓝色大肥鱼 Live2D，绘画与拆分为神宫凉子、Live2D 为霓虹猫_NeonNeko。`runtime-lock.json` 固定模型和 Core 的提交、各文件大小与 Git blob／SHA256，固定 MIT 渲染器版本、npm 完整性和浏览器包哈希。

```bash
npm run desktop:companion:install
npm run test:companion
node mac/companion/asset-check.mjs --installed
npm run desktop:build
# 先退出 AnyLink 窗口应用，后台 Agent 可继续运行
npm run desktop:install
open ~/Applications/AnyLink.app
```

模型和 Core 下载到被 Git 忽略的 `data/mac/companion/{model,runtime}`。安装器不改原始模型文件，单独生成 `entry.model3.json` 引用原有手势及表情；待机使用项目自有的头部轻摆、呼吸参数，避免原始演示动画影响手势。不激活换装和体型切换参数。首次素材约 63 MB，网络慢时允许较长下载时间；重试复用已验证文件。MIT 浏览器 JS 与许可证可随接入代码发布，人物、纹理和 Core 不进入仓库和安装包。

本机安装使用模型，不代表角色商业授权。社区 README 允许个人内容使用及参数调整，限制完整模型再分发与转售，收费产品／广告需向作者确认。详见 [原始使用须知](https://github.com/YJackie-Li/DeepSeek-chan/blob/main/README.md)、[本项目素材说明](../../mac/companion/ASSET-NOTICE.md) 和 [Live2D 发布条件](https://www.live2d.com/en/sdk/license/)。

## 验证与回退

`CompanionTests.swift` 检查活跃状态、sharedFacts、终态、attention 过期、多屏负坐标及位置约束。`asset-server.test.mjs` 使用临时目录检查读取、HEAD、错误路径、符号链接逃逸、禁止写入和父 stdin 关闭后退出。`asset-check.mjs` 校验渲染器内容哈希；`--installed` 校验实际人物素材及动作引用，并检查安装包不含受限资产。

`renderer.test.mjs` 验证高频原生输入与减少动态效果切换不会重复注册动画 ticker，防止手势被快速跳过及渲染资源持续增长。

为适配该模型的 Cubism 5 drawable multiply/screen colors，`patch-renderer.mjs` 从固定上游包生成单独的兼容 JS，覆盖普通、遮罩与反向遮罩片元着色。保留原上游文件、MIT 许可证、补丁来源和生成文件内容哈希；修复依据为 [AIRI #3323](https://github.com/moeru-ai/airi/pull/3323)。不通过删除鼻子部件或改人物纹理规避渲染错误。

`data/mac/desktop/companion-state.json` 仅保存可见性、状态、渲染是否就绪、最近动作、活跃数量和窗口位置，权限 0600；不保存聊天、任务名、令牌或画面。可用于排查加载与状态问题。原生应用和 Peekaboo helper 均经过 codesign 验证。

回退先退出桌面应用，用安装器保留的 `~/Applications/.AnyLink.previous-*.app` 替换当前壳。也可基于 `v0.3.0` 重新构建桌面壳。不清理模型、用户配置、工作区、OpenClaw 会话或云端数据库。隐藏角色即可停止本版新增渲染，不需回退服务器。

## 2026-11-22 本机验收

- 原生应用成功编译、安装；Info.plist、应用及原有签名 Peekaboo helper 的 codesign 检查通过。
- 正常比例的完整蓝色大肥鱼在桌面显示；眨眼、头部、头发与尾巴动态可见。抬手致意、竖手指和点头菜单接通，前两者已观察到完整姿态及返回待机。
- 大小切换、隐藏、恢复、打开原聊天、退出与重新启动已验证；保留本机形象偏好。多屏负坐标和窗口位置约束通过 12 项 Swift 检查。
- 资源服务访问边界及高频输入的 ticker 生命周期两项 Node 测试通过；所有 19 项固定模型文件、Core 和渲染器内容校验通过。
- `node mac/companion/acceptance.mjs` 在单独会话完成真实云端模型流，收到 665 次文本增量；本机投影依次为待命 → 忙碌（1 个活跃会话）→ 本轮结束 → 待命。没有要求工具执行、记忆写入或外部消息。报告留在忽略的 `artifacts/desktop-companion-acceptance.json`。
- TypeScript 检查通过；源码与应用 Resources 共 164 个文件的凭据检查无命中。Git 与安装包未包含人物模型、纹理或 Core。云端仍为 V0.3，未做服务迁移或部署。
