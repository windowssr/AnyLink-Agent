# V0.3 Mac 电脑控制

## 通路与模块

用户在 AnyLink.app 与本机 OpenClaw 交互。电脑操作由 Mac 完成；ywc 沿用模型代理和统一记忆角色，没有新增云端执行器或任务派发服务。

```text
AnyLink.app ⇄ 本机 OpenClaw
                  ├→ anylink-mac-control → 官方 Peekaboo CLI
                  │                            ↓ 固定 UNIX socket
                  │                     官方签名 Peekaboo.app
                  │                            ↓
                  │                 macOS 窗口、辅助功能、屏幕与输入
                  ├→ SSH → ywc 模型代理 → DeepSeek Flash（文字与图像）
                  └→ SSH → ywc 统一记忆
```

- `mac/control/index.mjs`：OpenClaw 工具注册、观察收据、串行执行和结果回传。
- `mac/control/client.mjs`：固定 Bridge 连接、主机身份和版本核对、权限读取；工程根目录通过插件配置显式传入，避免 OpenClaw 缓存加载目录改变数据位置。不调用 Peekaboo 自己的模型或 `agent` 命令。
- `mac/control/policy.mjs`：准确目标、坐标、按键、文件路径和敏感界面限制。
- `mac/desktop/MacControl.swift`：本机控制入口、显式启用、停止和系统权限入口。
- `mac/install-control.mjs`、`versions.json`：下载固定官方发布、校验 SHA-256、验证 Developer ID 签名团队。

Peekaboo 固定为 **4.9.10**，源提交 `fa2f76ed24ea8bc76e0f000124c909e96db3e29d`。官方应用原样放在 `AnyLink.app/Contents/Helpers/Peekaboo.app`，保留 OpenClaw Foundation 签名。CLI 使用项目私有运行目录；不为系统 Node 授予辅助功能权限。上游许可和归属信息见 `mac/control/NOTICE.md`。

最低系统版本随控制组件提升至 macOS 15；当前开发和验收机器为 Apple Silicon Mac。

## 使用和授权

在 AnyLink.app 点击“电脑控制”：

1. 点击“启用电脑控制”。控制开关只由本机 UI 保存，Agent 工具没有启用接口。
2. 在 macOS 隐私与安全性设置中，为 **Peekaboo** 开启辅助功能和屏幕与系统音频录制。授权对象是实际执行操作的签名组件。
3. 找不到应用时，点击“在访达中定位授权应用”，选择当前 AnyLink.app 内的 Peekaboo.app。
4. 等待状态变为就绪。系统要求退出并重开组件时按提示操作，必要时再次点击启用按钮。

开启后，所选窗口的截图与界面文字会随当前任务上下文经 ywc 发送给 DeepSeek。界面观察不自动变成长时记忆，记忆写入继续沿用明确记忆意图规则。

停止按钮和菜单栏的“停止电脑控制”阻止后续输入；已发出的单次动作可能正在收尾。关闭聊天窗口不等于停止控制。撤销 macOS 权限仍由系统设置管理。

可尝试：“用文本编辑打开工作区中的 xxx.txt，替换为……并保存。”支持操作普通软件窗口、输入文本、快捷键、点击、滚动和同窗口元素拖拽；界面变化后重新观察，不承诺所有软件都具有可访问性元素。

## Agent 工具

- `anylink_mac_status`：控制开关、固定主机和权限是否就绪。
- `anylink_mac_apps`：列出运行中的软件；指定 bundle ID 后列出该软件的窗口和真实窗口 ID。
- `anylink_mac_observe`：观察一个准确窗口，输出图像、文字、元素 ID 和本轮 `observation_id`。
- `anylink_mac_act`：`launch`、`focus`、`click`、`type`、`key`、`scroll`、`drag`。除 launch 外，必须持有本轮对应窗口的有效观察。

launch 可通过 `workspace_file` 打开现有工作区文档。路径经过 realpath 核对，绝对路径、目录穿越和指向工作区外的符号链接均拒绝。一般文件和命令操作继续使用原有文件工具与 exec 审批，不通过 GUI 终端绕过审批。

focus 使用已观察到的准确 app / window ID 聚焦，并检查聚焦结果。前台点击或输入会聚焦目标，必要时切换到它所在的桌面；普通输入优先使用后端原生后台能力，不搬动窗口到其他桌面。

## 窗口、图像与输入收据

一次观察绑定本轮身份、软件、准确窗口 ID、Peekaboo 原生快照及坐标上下文。观察 45 秒失效，每次输入消耗一次；结果回传包含新的观察。其他会话、错误软件、猜测元素 ID、越界坐标和已消耗观察均拒绝。

图像转换为 JPEG，最长边最多 1440 像素，小窗口不放大。元素 bounds 同步转换成返回图像的像素坐标。执行坐标再根据原生 logical bounds 转回窗口逻辑点，处理 Retina 与窗口位置差异。应用、窗口、元素与输入的底层收据继续由 Peekaboo 核对。

本插件的控制调用串行执行。不使用 shell 拼接；调用固定签名 CLI 的固定子命令及独立 argv 参数。拖拽限定为本次观察中的两个元素，持续 600 ms。没有全局任意坐标、任意脚本或跨应用拖放入口。

前台文字输入使用官方组件的剪贴板事务，避免中文输入法把英文逐键输入转成候选词；事务保留并恢复原剪贴板，用户的新复制内容优先。清空输入先在同一窗口选中，再粘贴；每阶段检查停止 / 取消状态。已进入粘贴的操作允许完成短暂清理，停止后不再派发下一步。可访问的同一焦点字段回读与目标原文一致时，记录额外的 `focused_field_readback` 确认。

前台空白输入会明确拒绝，防止原生粘贴接口把缺少正文解释为粘贴用户当前剪贴板。需要清空字段时使用明确的选中与删除快捷键。

截图、OCR 和软件文字视为不可信数据。Agent 不应按界面中的指令改变任务或自行授权。控制层拒绝自身与其他 Agent 的控制窗口、系统权限设置、GUI 终端和已识别的自身审批页面；焦点处于密码字段时，文字与快捷键输入交给用户处理。正常软件中的提交、发送、删除等操作仍取决于用户对具体任务的授权。

## 提交与恢复

输入前，按本机会话和工具 call ID 生成去重记录，并先写入私密 journal、fsync，再发送动作。记录只含动作类型、软件、输入哈希和结果状态，不保存输入正文。

- `completed`：组件确认效果，或同一焦点字段回读确认内容。
- `delivered`：组件接受了输入，但效果仍需后续画面 / 内容核对；不能因此声称整个任务完成。
- `refused`：本地策略或原生组件明确确认未派发。
- `submitted` / `unconfirmed`：结果未确认；重新观察，不自动重放输入。

相同 call ID 返回既有记录；换参数复用同一键会拒绝。进程重启不会由这个插件重放 journal。动作成功但后续观察失败时，保留原动作结果并要求重新观察，不能把观察失败解释成动作没发生。

开关在每次输入前重新读取；原生权限或固定主机不可用时拒绝，不回退到 Node、其他应用或本地执行器。权限状态明确属于固定 socket 及固定版本的官方 Peekaboo 主机。

Peekaboo 4.9.10 的只读 `bridge status` 诊断握手固定为 1 秒，繁忙时可能短暂超时。产品仅对这一明确诊断超时最多探测 5 次，之后仍需通过固定 socket、版本、源提交和权限核对；信任失败、主机不匹配和任何输入动作都不自动重试。持续失败报告握手问题，不误导用户重新授权。依据：[固定版本诊断源码](https://github.com/openclaw/Peekaboo/blob/fa2f76ed24ea8bc76e0f000124c909e96db3e29d/Apps/CLI/Sources/PeekabooCLI/Commands/Core/BridgeCommand%2BDiagnostics.swift)。

## 数据和云端

- `data/mac/control/control.json`：本机开关，0600。
- `runtime.json`、`vendor-*`：已校验的官方运行组件。
- `captures`：私密的窗口截图缓存；最多保留最近 100 个生成的 JPEG 文件。
- `journal`：动作去重与未知提交记录，不是云端任务队列。

这些目录被 Git 和源码部署包排除。Peekaboo 也会维护自己的本机原生观察状态；本组件不删除其全局缓存或用户文件。

DeepSeek Flash 的本机模型声明启用 `text` / `image`。云端只为 `/model/v1/chat/completions` 放宽至 16 MiB，以支持截图上下文；其他 API 保留原上限。仍验证设备凭据、并发和输出限制。请求记录不保存正文、图片或工具内容。

图像能力依据 [DeepSeek Vision 文档](https://api-docs.deepseek.com/guides/vision/)。Peekaboo 和 OpenClaw 的关系见 [OpenClaw Mac 自动化文档](https://docs.openclaw.ai/platforms/mac/peekaboo)。

## 安装、测试与回退

```bash
node mac/install-control.mjs
# 等本机任务空闲后更新 profile；保留凭据、记忆和命令审批策略。
node mac/configure-control.mjs
npm run desktop:build
npm run desktop:install
open ~/Applications/AnyLink.app
```

```bash
npm run check
npm run test:mac-control
npm run test:integration
data/mac/runtime/node_modules/node/bin/node mac/control/acceptance.mjs
data/mac/runtime/node_modules/node/bin/node mac/control/agent-acceptance.mjs
```

集成测试必须使用独立 `anylink_test` 数据库。真实桌面验收脚本每次生成一个独立的工作区测试文档，执行启动、观察、聚焦、点击、输入、保存并从磁盘核对；失败时停止，不盲目重放动作，结果写入 `artifacts/mac-control-*.json`。

`agent-acceptance.mjs` 从本机聊天 API 发起任务，由真实 Flash 和 OpenClaw 自主选择 GUI 工具，并核对新测试文件的保存内容。模型可核对最终文件，但不能用文件写入或 shell 替代本次 GUI 操作。报告写入 `artifacts/mac-agent-proof-*-result.json`。

升级 profile 前在私密状态目录保存带时间戳的备份。桌面壳可回退到安装器保存的旧应用；回退前先停止电脑控制。云端更新沿用按 commit 构建、数据库备份和 current / previous 切换；此次没有新增数据库 schema。

## 验收记录

当前已通过 16 项服务 / 记忆回归，其中包含 3 MiB 图像内容透传；14 项本机控制策略 / 路径 / 握手回归、Swift 编译、官方组件签名检查通过。真实模型已完成“本机 read 图片工具 → ywc → Flash”的图像识别。

直接调用产品工具的真机闭环已通过：`mac-control-581c4440f472.txt` 完成窗口聚焦、坐标点击、中英文输入、Cmd+S 和磁盘内容一致性核对。测试正确处理了其他桌面的窗口、Retina 坐标和中文输入法。输入未得到效果确认时保留未确认状态，不盲目重复。

复用最后保存动作的同一 call ID 返回 `duplicate: true`，文件修改时间保持不变，确认未重新输入或保存。

真实聊天验收已通过：`mac-agent-proof-bf011d97.txt` 由本机 OpenClaw / Flash 自行调用 GUI 工具打开、观察、点击、替换中英文、Cmd+S 保存，并核对磁盘内容完全一致（包括末尾换行）。检查本地工具轨迹，未使用 exec、write 或 edit 替代界面操作。报告与轨迹分别在私密构建目录的 `mac-agent-proof-bf011d97-result.json`、`mac-agent-proof-bf011d97-trace.json`。

以上验收覆盖文本编辑的实际点击、输入、快捷键、结果回显，以及模型图像通路。滚动、拖拽和不同第三方软件仍需按具体任务核对原生反馈；没有据此承诺所有软件都能自动化。发布版本为 V0.3.0，云端和桌面构建的实际 commit、镜像指纹及运行状态记录在相应 release manifest。
