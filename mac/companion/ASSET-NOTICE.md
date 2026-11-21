# 蓝色大肥鱼桌面模型

本地使用 DeepSeek-chan（蓝色大肥鱼）Live2D 模型。绘画与拆分：神宫凉子；Live2D：霓虹猫_NeonNeko。社区存档及原始使用须知：https://github.com/YJackie-Li/DeepSeek-chan/blob/main/README.md 。该社区仓库不等于已取得原作者的商业授权。

人物模型、纹理和 Live2D Cubism Core 仅由安装脚本获取到忽略的 `data/mac/companion`，不进入 Git 或 AnyLink 安装包。原始文件不改动，单独的本地入口声明已有动作。不能将模型当作 AnyLink 自有素材转售或再次完整分发。将人物用于收费产品、广告或公开商业发布前，应向角色作者确认许可。

Cubism Core 按 Live2D 专有软件许可使用：https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html 。SDK 应用发布条件：https://www.live2d.com/en/sdk/license/ 。本地开发成功不代表已满足商业发布条件。

浏览器渲染器：PixiJS 6.5.10 与 pixi-live2d-display 0.4.0，均为 MIT；许可证随 `vendor` 中的文件保留。`runtime-lock.json` 固定上游版本、提交与内容哈希。

`cubism4-colors.min.js` 是对固定上游渲染器的可重复兼容构建，补充 drawable multiply/screen colors，覆盖普通、遮罩、反向遮罩，修复该 Cubism 5 模型鼻子上的黑块。依据 AIRI 的 MIT 修复：https://github.com/moeru-ai/airi/pull/3323 ，保留 `AIRI-LICENSE.txt`。未修改人物纹理、几何和署名。

聊天界面头像与页签图标由同一本机模型渲染生成，只保存在忽略的本机数据目录，不随 Git 发布。界面换标不改变人物来源和作者署名。
