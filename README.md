# AnyLink Agent

Mac 上运行成熟 OpenClaw，自己服务器提供统一记忆和模型 API。用户与本地 Agent 交互；会话、上下文、工具循环和结果留在本机，服务器直连 DeepSeek 并保存 global / device 事实。

```text
用户 ⇄ Mac 本地 OpenClaw ⇄ Mac 原生工具
              ├⇄ ywc 模型代理 ⇄ DeepSeek Flash
              └⇄ ywc 记忆 API ⇄ PostgreSQL
```

当前服务版本 V0.3，Mac 桌面版本 V0.4，使用独立 Node 24.22.3、OpenClaw 2026.11.6、AnyLink memory 和电脑控制插件。电脑控制通过固定版本的官方签名 Peekaboo 4.9.10 执行；桌面新增正常比例的蓝色大肥鱼 Live2D 伙伴。Android、语音和设备间协作进入后续阶段。旧 V0.1 云端 Agent 已退役，历史状态保留。

## 在当前 Mac 使用

双击 `~/Applications/AnyLink.app`，即可在独立 Mac 窗口中聊天、查看工具执行结果；菜单栏提供电脑控制、重新连接、工作区和日志入口。关闭窗口或退出桌面壳后，后台 Agent 继续运行。

桌面伙伴可以拖动、单击举手、双击打开聊天；右键可选择举手、竖起手指、点头、大小和隐藏。工具栏“桌面伙伴”可重新定位角色。状态气泡读取本地 Agent 的只读运行状态，不产生另一条模型请求。角色和 Core 只安装在本机，商业发布需另行确认素材许可，详见[桌面伙伴说明](docs/implementation/08-desktop-companion.md)。

在“电脑控制”中显式启用，并为 Peekaboo 开启 macOS 辅助功能和屏幕录制权限后，可以操作所选软件窗口、点击、输入、快捷键、滚动和拖拽。窗口截图与界面文字随任务经 ywc 发送给 Flash 理解；停止按钮可阻止后续控制。详情见[Mac 电脑控制说明](docs/implementation/07-mac-computer-control.md)。

重新构建与安装桌面壳：

```bash
node mac/configure-desktop.mjs
node mac/install-control.mjs
node mac/configure-control.mjs
npm run desktop:companion:install
npm run desktop:build
npm run desktop:install
open ~/Applications/AnyLink.app
```

应用读取当前工程已配置的本机连接，不在应用包中嵌入凭据。此包适用于已经完成本机安装的 Mac，迁移工程后需要重新构建。详见[Mac 桌面应用说明](docs/implementation/06-mac-desktop.md)。

浏览器入口仍可使用：

```bash
cd /Users/yundongwu/self-program/anylink-agent
node mac/cli.mjs open
```

此命令在默认浏览器打开经过本机认证的聊天界面，不打印令牌。地址为 <http://127.0.0.1:18791/openclaw/>。若需要手动填写本地 Gateway Token，在自己的终端运行 `node mac/cli.mjs token`；不要把输出发到聊天或提交 Git。

初始文件工作区为 `data/mac/workspace`。可以让 Agent 创建、读取和修改这里的文件。文件工具限定于工作区，进程命令沿用 OpenClaw allowlist / on-miss 审批；普通软件操作走专用 Mac 控制工具。

明确说“记住……”时，本地 Agent 使用云端记忆工具保存；新会话会读取当前 global 和 Mac 事实。记忆更正使用 revision，删除后不再作为当前事实召回。原始会话仍可能包含历史陈述。

## 服务与数据

本机当前用户 LaunchAgent 为 `com.anylink.openclaw`。它运行独立 Gateway 和 3181 → ywc 回环 3180 的专属 SSH 连接。连接断开时自动重连，本地 UI 保持可用；正常停止先让原生 Gateway 收尾，再关闭隧道。

云端 Compose 只定义 app、postgres。模型 API 是 `/model/v1/chat/completions`，直接透传到 DeepSeek；记忆 API 是 `/edge/v1/...`。旧云端聊天和任务执行 API 返回 410，没有云端 Agent 主循环。DeepSeek Key 仅在服务器，本机只持可撤销设备服务凭据。

云端管理页只管理记忆、设备服务凭据和模型用量。另建以下隧道后访问 <http://127.0.0.1:3180/>：

```bash
ssh -N -L 3180:127.0.0.1:3180 ywc
```

主人令牌可在自己的终端通过 `ssh ywc 'cat /opt/anylink-agent/secrets/owner-token'` 读取。管理页不是日常聊天入口。

## 安装与更新

```bash
npm ci
node mac/install-runtime.mjs
node mac/pair.mjs
node mac/install-control.mjs
node mac/launch-agent.mjs
```

安装器使用 `mac/runtime-lock.json` 固定原生依赖；更新 runtime 前先正常停止本机服务。生成的 LaunchAgent 位于 `data/mac/com.anylink.openclaw.plist`，需要安装到当前用户 LaunchAgents 并 bootstrap。配置、会话、凭据、日志和工作区均在被 Git 忽略的独立目录，不覆盖其他 OpenClaw 安装。

服务器发布在干净提交上执行：

```bash
bash scripts/build-release.sh
bash scripts/deploy.sh artifacts/提交前12位 ywc
```

部署按 commit 和镜像内容指纹校验，先备份本项目数据库，失败可回退。不要对其他项目执行 Docker 清理。

## 检查与文档

```bash
npm run check
npm run build
npm run test:integration
```

集成测试必须连接独立 `anylink_test` 数据库，脚本拒绝其他数据库名。测试会重建测试库 schema，不能使用产品库。真实本机验收命令为 `node mac/acceptance.mjs`，会产生少量模型调用和带随机标识的验收文件 / 记忆。

- [安装、常驻、凭据与运维](docs/implementation/04-edge-operations.md)
- [Mac 桌面应用、构建与更新](docs/implementation/06-mac-desktop.md)
- [Mac 电脑控制、权限与验收](docs/implementation/07-mac-computer-control.md)
- [蓝色大肥鱼 Live2D 桌面伙伴](docs/implementation/08-desktop-companion.md)
- [V0.2 真实验收记录](docs/implementation/05-edge-validation.md)
- [当前产品设计](docs/product/README.md)
- [修正后的 Mac 施工基线](docs/implementation/03-edge-mac-plan.md)
- [V0.1 历史原型验收](docs/implementation/02-validation.md)
