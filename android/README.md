# AnyLink Android · V0.1 工程基线

HBuilderX 5.34、uni-app Vue 3。手机持有自己的会话和工具循环，使用固定的 `@earendil-works/pi-agent-core@1.6.0`；服务器继续只提供模型代理与统一记忆。界面里只有一个“大肥鱼”，人物动作由同一个本地 Agent 驱动。

本阶段按主人选择交付工程和电脑预览。已完成 Web 与 Android App 资源编译；没有生成签名 APK，没有连接或验证实际 Android 手机。

## 在当前 Mac 上预览

```bash
cd /Users/yundongwu/self-program/anylink-agent/android
npm ci --ignore-scripts --no-audit --no-fund
npm run prepare:app
npm test
npm run test:runtime
npm run build:preview
npm run preview
```

浏览器打开 <http://127.0.0.1:5180>，点“先看看演示”。可以对她说“你好，招招手”“看看这台手机的状态”“帮我写一条便笺：今天开始做安卓版”。演示回复由确定性测试适配器产生，不调用模型；Pi 工具循环、浏览器本地便笺和执行回执真实运行。页面始终标注演示状态，便笺、会话与正式数据分开保存。

`prepare:assets` 复用本机已有的 `data/mac/companion` 模型、Core 和 `data/mac/branding/avatar.png`，不重新下载完整模型。缺少这些私有素材时先按 Mac 模型安装说明准备。素材和生成的运行库不进入 Git。编译器默认复用 `/Applications/HBuilderX.app`，其他安装位置设置 `HBUILDERX_PLUGINS`。

## 真实云端连接

需要服务器签发的一条独立 Android 设备凭据。首次签发必须取得主人授权；本轮自动审批拒绝了新增预览凭据，默认保留本地演示，不借用 Mac 凭据。

获准后运行：

```bash
npm run pair:preview
# 使用现有 Mac 服务提供的 127.0.0.1:3181 SSH 隧道
npm run preview
npm run test:live
```

脚本经 `ssh ywc` 调用既有管理 API，只创建标注为“Android 开发预览（未绑定真机）”的逻辑设备。主人令牌始终留在服务器。设备凭据保存在忽略的 `secrets/android-preview-connection.json`，权限 0600；不进入源码、编译包、URL 或日志。

电脑预览的同源引导接口只在回环地址运行，并检查 Host、Origin 与自定义请求头；仅把该预览设备的凭据交给当前本地页面。网页通过本地开发代理连接现有 SSH 隧道，无需修改云端 CORS 或暴露服务公网端口。H5 连接只在内存保留，刷新后重新读取本地引导；Android App 构建不包含预览引导调用。

服务地址必须是 HTTPS，开发例外仅允许回环地址和 Android 模拟器桥接地址。真机阶段可用 `adb reverse tcp:3181 tcp:3181` 经 Mac 隧道调试，或另行部署手机可访问的 HTTPS 入口；当前没有设置公网访问。

## HBuilderX 工程与 Android 资源

在 HBuilderX 中打开本目录。先运行准备命令，再使用“运行到手机或模拟器”。命令行可先检查资源编译：

```bash
npm run build:app
```

输出为 `unpackage/dist/build/app-plus/`，属于 App 资源，不能直接当 APK 安装。`manifest.json` 的 DCloud AppID 留空，签名 APK 阶段由主人账户生成真实 AppID 并配置自己的证书；没有冒用 AppID、自动创建账户或提交云打包。

## 已接入的能力

- 单一聊天入口，本地对话记录、流式响应与停止；本地 Pi 负责工具多轮调用。
- 云端 global / 当前 device 事实读取；记忆查询、保存、更正和删除，revision 与幂等键对接既有接口。
- 手机基础状态，以及 AnyLink 私有便笺保存、读取；不宣称已接通其他 App 操作。
- 复用蓝色大肥鱼 Live2D，表情、招手、指向和点头；人物请求与实际渲染状态分开。
- Android 凭据采用 Keystore AES-GCM 封装，失败时拒绝明文保存；仍需真机验证 Native.js 调用。
- 取消、后台切换、网络中断与进程终止后，未确认运行不自动重发。工具执行记录在副作用前落盘；重复工具调用返回既有回执。

## 后续真机验收

Android 原生网络是否逐段交付 SSE、Keystore、系统状态接口、GPU 和 WebView 表现、锁屏与进程回收，均以手机验收为准。当前不包含语音通话、系统悬浮宠物、通知推送、无障碍跨 App 操作、后台常驻和手机向 Mac 派任务。App 内人物已经接入，手机桌面悬浮形象是另一项原生能力。

实现与验收记录见 [Android 施工说明](../docs/implementation/12-android-foundation.md)，模型来源见 [素材说明](THIRD-PARTY-NOTICES.md)。
