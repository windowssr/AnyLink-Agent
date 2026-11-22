# 依赖与人物素材来源

- Agent：`@earendil-works/pi-agent-core`、`pi-ai`、`pi-schema` 固定 1.6.0，MIT。源代码与许可：[earendil-works/pi](https://github.com/earendil-works/pi)。只打包本地 Agent 和协议工具所需的浏览器兼容代码，不携带 Node.js、远端 Agent 进程或模型提供商凭据。
- Pi 和 Vue 的许可正文保留在 `static/licenses/`，随本地编译资源输出。
- 界面：Vue 3.4.21，MIT；uni-app 使用本机 HBuilderX 5.34 自带的编译器和运行库，使用条件由 DCloud 上游说明约束。
- 人物：沿用本机 DeepSeek-chan（蓝色大肥鱼），绘画与拆分为神宫凉子，Live2D 为霓虹猫_NeonNeko。社区来源：[使用须知](https://github.com/YJackie-Li/DeepSeek-chan/blob/main/README.md)。人物及纹理未作为 AnyLink 自有资产发布到仓库。
- Live2D Cubism Core 为专有依赖，沿用既有本地文件及上游许可；PixiJS 6.5.10、pixi-live2d-display 0.4.0 与 AIRI 兼容补丁采用 MIT，对应许可随本地静态资源保留。

详细素材边界和来源沿用 [Mac 素材说明](../mac/companion/ASSET-NOTICE.md)。本轮生成的 App 资源仅作为本机私有开发产物，不是公开 APK 发布。
