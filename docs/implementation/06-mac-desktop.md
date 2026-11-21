# Mac 桌面应用 V0.2.1

本文记录 V0.2.1 的桌面壳基线。当前 V0.3 已加入电脑控制，安装时还需准备固定的 Peekaboo 组件；当前使用、权限和验收方式见 [Mac 电脑控制](07-mac-computer-control.md)。

## 使用入口与能力

在当前 Mac 双击 `~/Applications/AnyLink.app`。应用使用 Swift / AppKit 创建原生窗口和菜单栏入口，通过 WKWebView 显示本机 OpenClaw Control UI；不依赖浏览器标签页或 Electron。

交互通路保持为：

```text
AnyLink.app → 127.0.0.1:18791 本机 OpenClaw → 本机工具
                         ├→ SSH → ywc 模型 API → DeepSeek
                         └→ SSH → ywc 记忆 API
```

聊天、会话、工具循环和结果仍由本机 Agent 处理。服务器没有新增 Agent 或设备控制入口。本次只增加桌面壳，不需要更新云端部署或数据库。

当前已配置的文件工具限定于 `data/mac/workspace`；命令工具使用 OpenClaw allowlist / on-miss 审批。`.app` 不会额外取得任意文件、鼠标键盘、其他软件窗口、麦克风或录屏权限。任意 GUI 自动化仍需后续接入桌面控制工具并完成必要的系统授权。

## 窗口与生命周期

- 主窗口提供聊天、工具调用和结果展示，沿用原生 OpenClaw UI。
- 顶部显示本机 Gateway 的连接状态，提供工作区与重新连接按钮。该状态只检测本机服务存活；云端 API 可用性以实际模型 / 记忆请求结果为准。
- 菜单栏的链接图标可重新显示窗口、打开工作区或重新连接。
- 关闭窗口保留菜单栏；退出应用只退出桌面壳，已安装的后台 Agent 继续运行。
- 后台服务未运行时，尝试 bootstrap / kickstart 当前用户已有的 `com.anylink.openclaw` LaunchAgent，不使用强制重启，不另开第二个 Gateway。
- Gateway 冷启动可能需要约一分钟；没有安装服务或本机配置缺失时，显示具体处理指引。
- “重新连接”刷新本地 UI，不取消正在执行的 Agent 任务。
- 对固定的 OpenClaw 2026.11.6 UI，新建会话可能卡在面板重新连接状态。桌面壳只读检测这一状态：本机健康、没有未发送草稿且持续约 12 秒时，每条会话最多自动刷新一次受保护文档。它不读取聊天内容、不重发模型请求，也不点击发送；仍未恢复时可手动重新连接。
- UI 使用官方 `gateway.controlUi.basePath=/openclaw`。聊天深层链接通过官方受保护的 `__openclaw__/session-entry?path=...` 入口加载，避免先进入公开阅读页面。重新连接和重启应用会保留当前会话路径；保存路径时排除认证 fragment。

## 构建与安装

前置条件：Mac 已按照 [Mac 运维说明](04-edge-operations.md) 安装 runtime、完成配对并安装 LaunchAgent。构建还需要 Xcode Command Line Tools；不需要完整 Xcode IDE。

```bash
cd /Users/yundongwu/self-program/anylink-agent
node mac/configure-desktop.mjs
npm run desktop:build
npm run desktop:install
open ~/Applications/AnyLink.app
```

源码在 `mac/desktop/App.swift`，图标由 `mac/desktop/Icon.swift` 的矢量绘图生成，版本和最低系统版本来自 `mac/desktop/version.json`。构建产物为 `artifacts/desktop/AnyLink.app`。构建脚本记录 Git 提交、检查 Info.plist、执行本地 ad-hoc 签名并验证签名。最低声明 macOS 14，当前构建仅包含构建机器的 CPU 架构。

从 V0.2 升级时先等待本机任务结束，再运行 `configure-desktop.mjs`。它只更新 UI basePath，保留凭据与其他设置；首次修改前在私密状态目录保存带时间戳的配置备份。Gateway 会按官方配置热更新机制重新加载。已经配置则无操作。新安装由配对步骤直接生成这一设置。

应用包只保存当前工程的绝对路径，运行时读取工程的私密凭据。安装到其他 Mac 前仍需在那里安装 runtime、配对并构建；这不是包含全部依赖的通用分发安装器。移动或删除工程会使应用无法找到配置，移动后重新构建并安装即可。

安装器只替换 bundle identifier 为 `com.anylink.desktop` 的目标应用。更新前需要退出桌面壳；无需停止后台 Agent。已有应用保存在用户 Applications 下的隐藏 `.AnyLink.previous-时间.app`，不会覆盖无关同名应用。

## 认证与网络

- Gateway Token 运行时从 `secrets/mac-gateway-token` 读取，校验当前用户归属及无组 / 其他用户访问权限。
- 凭据通过本机 URL fragment 交给原生 UI；首次加载受保护文档时同时在本机请求的 Authorization header 中传递。凭据不打印、不放入 app bundle，也不写入构建配置。session-entry 继续由 Gateway 校验会话权限，没有绕过认证。
- WKWebView 使用独立应用的持久站点存储，以保留 UI 设置和本机设备身份。其浏览器认证状态属于当前用户的应用数据；清除此数据可能需要重新完成 UI 的本机设备认证。
- 原生应用只加载 `http://127.0.0.1:18791` / `http://localhost:18791`。外部 HTTPS 链接交给默认浏览器，移除 fragment；其他来源的导航拒绝。
- 应用没有可从网页调用的任意原生命令桥。文件上传使用系统文件选择框，只有用户选中的文件交给本机页面。
- ATS 只声明本地网络访问，没有全局关闭网络安全限制。对应键依据 [Apple 的 NSAllowsLocalNetworking 文档](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking)。文件上传接口依据 [Apple 的 WKUIDelegate 文档](https://developer.apple.com/documentation/webkit/wkuidelegate/webview(_:runopenpanelwith:initiatedbyframe:completionhandler:))。

## 排障与回退

界面暂未连接时点击重新连接，或从“助理 → 打开日志文件夹”检查本机服务。不要复制包含凭据的完整配置或认证 URL。后台服务的管理方式仍见 Mac 运维说明。

桌面壳更新异常时，退出桌面壳，将当前 `AnyLink.app` 移到其他位置，把对应的隐藏 `.AnyLink.previous-时间.app` 恢复为 `AnyLink.app`。这不会修改工作区、会话、私密凭据或云端事实。

也可以继续通过 `node mac/cli.mjs open` 使用本机浏览器入口。卸载桌面壳只需移走 `~/Applications/AnyLink.app`；是否停止 LaunchAgent 由后台服务的运维命令单独控制。

## 验证记录

2026-11-22，在当前 Apple Silicon Mac（macOS 26.5.1、Swift 6.3.3）完成以下实际检查：

- Swift 原生编译通过；Info.plist 检查、ad-hoc 签名及签名验证通过。
- 已安装到当前用户 `~/Applications/AnyLink.app`，原生窗口显示中文聊天界面与 DeepSeek Flash via AnyLink 模型。
- 从应用中新建会话，实际调用本机 write / read 创建并回读 `anylink-desktop-proof-20261122.txt`，窗口显示工具完成和文件内容。
- 在同一会话追加读取请求，实时收到工具结果与最终回复。
- 另建会话验证 `cat anylink-desktop-proof-20261122.txt` 的“允许一次”审批和执行结果；没有选择“始终允许”，没有扩大持久命令权限。
- 最终新会话回归在无需手动刷新时，4 秒完成 read 工具与内容展示；该会话只记录一条用户输入和一次 read 调用。
- 退出桌面壳期间，LaunchAgent 保持运行；重启桌面壳后恢复到原会话，结果仍在。
- 点击重新连接后，保留同一会话并恢复为已连接状态；本地记录仍只有原来的两条用户输入、三个工具调用和两条最终回复，没有重发任务。
- 加载界面时保持 WebKit 视图可见并以原生状态卡覆盖，避免隐藏视图挂起模块初始化；离窗使用官方 throttle 策略。
- `npm run check`、Node 脚本语法检查、Git whitespace 检查通过；源码和应用包扫描未发现本机 Gateway Token 或设备服务凭据。

以上不代表任意 GUI、语音、Android、Developer ID 分发签名或公证已完成。云端沿用已验收的 V0.2 服务，本次没有云端变更。
