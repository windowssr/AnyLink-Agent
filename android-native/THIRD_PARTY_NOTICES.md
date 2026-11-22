# Android 原生改版来源

- 原生 App 基于 [OpenClaw v2026.11.6](https://github.com/openclaw/openclaw/tree/v2026.11.6/apps/android)，完整提交由 `upstream-lock.json` 固定。保留 [OpenClaw MIT 许可](licenses/OpenClaw-MIT.txt)；本目录的 overlay 和准备脚本是 AnyLink 的私有产品适配，不是官方发行包。
- 官方 Android 工程的依赖许可清单与许可界面继续保留。原生图表使用相同版本的 Pele 和 DOMPurify，构建保留原始 `native/NOTICE.txt` 与沙箱实现。
- AnyLink 人物渲染复用现有 PIXI / pixi-live2d-display / AIRI 的许可文本，准备脚本将其复制到原生许可资产目录。
- 大肥鱼模型、纹理和 Cubism Core 来自已有本机私有资源，不加入 Git。来源、使用范围和其他许可边界见 [现有素材说明](../mac/companion/ASSET-NOTICE.md)。开源代码的许可不替代角色和模型本身的授权。
- `renderer/package-lock.json` 固定构建依赖及完整性摘要；Vite 只参与资源构建，App 不包含 npm、Node 或包管理器。
