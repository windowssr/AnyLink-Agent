# Android 原生改版来源

- 原生 App 基于 [OpenClaw v2026.11.6](https://github.com/openclaw/openclaw/tree/v2026.11.6/apps/android)，完整提交由 `upstream-lock.json` 固定。保留 [OpenClaw MIT 许可](licenses/OpenClaw-MIT.txt)；本目录的 overlay 和准备脚本是 AnyLink 的开源参考适配，不是官方发行包。
- 官方 Android 工程的依赖许可清单与许可界面继续保留。原生图表使用相同版本的 Pele 和 DOMPurify，构建保留原始 `native/NOTICE.txt` 与沙箱实现。
- AnyLink 人物渲染复用现有 PIXI / pixi-live2d-display / AIRI 的许可文本，准备脚本将其复制到原生许可资产目录。
- 公开构建不包含大肥鱼模型、纹理、派生头像或 Cubism Core，默认使用原创占位形象。个人可以自行获取许可允许的素材进行私有构建，该构建不得直接上传公开 Release。来源、使用范围和其他许可边界见 [现有素材说明](../mac-openclaw/companion/ASSET-NOTICE.md)。开源代码的许可不替代角色和模型本身的授权。
- `renderer/package-lock.json` 固定构建依赖及完整性摘要；Vite 只参与资源构建，App 不包含 npm、Node 或包管理器。
