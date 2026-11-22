# 手机端 → Mac：只读文件名搜索

修订：2026-11-22。当前在 Android 电脑预览和真实 Mac OpenClaw 之间验收，Android App 资源同时编译；尚未连接实体手机。

## 产品通路

```text
手机端输入一句话
  → 本地 Pi Agent 经 ywc / DeepSeek 判断需要搜索 Mac
  → anylink_mac_search_files（结构化关键词、范围和数量）
  → 已配对 Mac 的 OpenClaw 插件检查凭据、设备、能力和搜索范围
  → Mac 执行文件名搜索并保存回执
  → 本地 Pi 接收回执，交给模型生成回复，并在界面展示实际文件列表
```

明确的只读工具请求不再启动第二个 Mac 模型回合。搜索执行属于 Mac OpenClaw 的插件，同一本地搜索实现也注册为 Mac Agent 的工具。云端不新增 Agent、任务调度器或搜索 API，仍只负责模型和记忆。

Mac 使用官方 `api.registerHttpRoute` 的 `auth: "plugin"` 接口，由插件验证专用凭据；没有把 Gateway 管理令牌交给手机，也没有开放通用工具执行入口。接口依据：[OpenClaw Gateway 插件路由](https://docs.openclaw.ai/plugins/architecture-internals/gateway-routes)。已核对本机固定版本 2026.11.6 的类型与实际加载结果。

## 范围和结果

首版按文件名关键词搜索，可选 `all`、`desktop`、`documents`、`downloads`、`projects`、`workspace`。当前 Mac 配置对应桌面、文稿、下载、`self-program` 项目目录和 AnyLink 工作区。关键词是字面量，支持中文、大小写和 NFKC 归一化；多个空白分隔关键词需全部出现在文件名中，不接受任意根路径或执行命令。

返回文件名、完整路径、相对路径、大小和修改时间，不读取文件正文，不打开、下载、修改、删除文件，不执行终端命令或 GUI 操作。隐藏项、符号链接和标准凭据 / 构建 / 依赖目录排除；返回 `coverage` 说明排除项。

默认最多返回 20 项，最多 50 项；扫描上限 40,000 项、10 秒、18 层。超过预算或目录不可读时标记 `partial` 和原因，不把局部未匹配当作全电脑不存在。macOS 未允许访问的目录会反映为不可访问，插件不修改系统权限。

## 配对与传输

本轮主人明确授权接通这项只读能力。`npm run desktop:peer:configure` 为已有 Android 预览设备创建独立 `ap_` 凭据，并登记到 Mac 本机策略：

- `secrets/mac-peer-policy.json`：Mac 设备 ID、开放目录、允许的发起设备、令牌哈希与 `files.search` 能力。
- `secrets/android-preview-connection.json` 的 `mac_peer`：目标设备、地址、专用令牌；原有 `ak_` 云端模型 / 记忆凭据保留。
- 文件权限 0600，Git 和编译产物均排除真实凭据。

当前手机端预览的同源代理把 `/anylink-peer/v1/*` 转给 Mac 的回环 Gateway `127.0.0.1:18791`。Gateway 和预览服务均保持回环绑定；没有开放公网端口或修改 ywc。App 传输层同样支持独立目标地址，非回环地址要求 HTTPS。

Mac 检查 Bearer 令牌、`X-AnyLink-Peer-Device`、`X-AnyLink-Target-Device` 及能力。`GET /anylink-peer/v1/capabilities` 查询已授权范围；`POST /anylink-peer/v1/files/search` 接受搜索。其余通用任务、读文件和写入动作均不支持。普通浏览器跨站请求和错配设备不会触发搜索。

把对应 Mac 策略中的 `enabled` 改为 false 即撤销该配对，下一次请求立即生效，缓存结果也不再交付。该只读配对与云端设备凭据是独立授权；需要停用文件搜索时应在 Mac 撤销配对，单独撤销云端模型凭据不等于删除 Mac 授权。配置脚本显式重跑会重新启用该预览配对，正常启动不会自行恢复被撤销的配对。

## 请求与回执

Android 使用已有本地运行 / 工具账本，以工具调用编号生成稳定幂等键。Mac 在搜索前保存 `submitted`，完成后保存发起设备、目标设备、请求 ID、参数指纹、状态与搜索结果，目录为 `data/mac/peer/receipts`，权限 0600。

同设备同请求的重复调用返回原回执，不重新扫描；同请求编号更换条件返回冲突。重启后发现原请求未完成时返回明确的未知状态，不自动重跑。手机校验回执设备和只读标记，错配结果不交给模型采信；未知结果终止当前自动工具循环。

Mac 同时只执行一次搜索。手机停止回复或切到后台时，取消信号关闭请求，Mac 有界遍历在检查到取消后停止。搜索本身只读，但回执仍明确保存完成、取消或中断状态。

## 本机启用与验证

```bash
npm run desktop:peer:configure
node mac/cli.mjs config validate
npm run test:peer
cd android
npm test
npm run test:runtime
npm run build:preview
npm run build:app
npm run test:peer:live
```

本机插件已加载；最终中文分块修复在任务和语音空闲时平滑重载 Gateway。预览代理已重启。刷新 <http://127.0.0.1:5180> 后，Agent 会自动获得已配对的 Mac 搜索工具。

可直接说：“帮我在 Mac 的项目目录里找一下文件名包含 12-android-foundation 的文件，把完整路径发给我。”

本轮验收结果：

- Android 16 项测试、Mac 搜索和 HTTP 10 项测试通过，隔离 JavaScript 运行库验证通过。
- 真实 DeepSeek 自然语言请求调用 1 次 Mac 搜索工具，2 次模型调用，约 4.4 秒返回已核验的完整文件路径。
- 核对了真实 Mac 插件回执、手机侧本地账本、发起与目标身份、重复请求复用、变更参数拒绝，以及被搜文件大小和修改时间未改变。
- 中文文件名、UTF-8 跨 HTTP 分块、路径和额外操作拒绝、符号链接 / 凭据目录排除、撤销、未完成回执不重跑均有测试。
- Web 预览和 Android App 资源编译通过；验收元数据保存在忽略的 `artifacts/android-peer-acceptance.json`。
- 浏览器界面自动化连接超时，本轮没有额外完成可视验收；通过的是手机端同一 Pi 核心经真实模型、同源代理、Mac 插件的端到端接口通路。

当前没有新增签名 APK 或真机安装。实体 Android 阶段仍需独立手机身份与配对、USB 反向端口或可达的 HTTPS 通道，以及原生网络 / 后台验证；不能把本机浏览器预览当作已经完成异地手机联网。
