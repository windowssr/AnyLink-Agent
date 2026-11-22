# 通用接入层与开源发布

当前主定位为 AnyLink 协议／SDK，OpenClaw Mac／Android 是参考客户端。协议版本 v1，SDK 0.1.0，参考服务 0.4.0，Mac 0.8.0，Android 0.2.0-preview.2；首个公开资源集合为 v0.8.0-preview.1。

## 执行通路

来源项目使用设备凭据提交结构化任务，服务器从认证确定来源，核对主人授予的 source／target／capability 和目标声明的能力。目标 Worker 通过出站 HTTP 领取任务，服务器用行锁与 SKIP LOCKED 原子更新为 running。云端不执行处理器，也不调用另一个 Agent 解释任务。

Worker 的 SQLite journal 绑定服务地址和认证设备 ID，在任何回执重发前核对绑定。执行前持久写入 started；处理器完成后先保存 finished，再提交结果，服务确认后标为 reported。重启只重发 finished，started 没有结果则视为未知，不重跑。对外副作用由宿主自行检查授权、工作区和审批。

服务器的 link_capabilities、link_grants、link_tasks 是 migration 3 的新增表，不替换既有记忆和请求记录。任务可 queued、running、cancel_requested 或进入 succeeded／failed／cancelled／unknown／expired。过期只影响尚未领取的任务；撤销授权阻止后续准入，不声称撤销外部动作。空领取不占用持久幂等记录，实际领取后的键才重放原回执。

## 接口边界

SDK 主入口不导入 Node 专属模块；Node Worker 是独立的 `./worker` 子入口。模型代理可选，没有 provider Key 时仍可运行记忆和任务服务，模型接口返回 PROVIDER_NOT_CONFIGURED。模型流保留原工具调用及用量事件，SDK 不自动重试模型或未知提交。

OpenAPI 从服务端 schema 生成并纳入漂移检查，协议说明涵盖身份、数据作用域、任务状态、幂等键和恢复。服务仍为单主人信任域，逻辑设备不是硬件证明，也没有新增多租户隔离承诺。

Codex 参考 handler 使用操作者指定工作区和 CLI 文件系统只读模式，通过 stdin 接收提示词。它启动独立 CLI 任务，不操控已有桌面聊天，不替换 Codex 登录／模型，不转发交互审批。宿主仍须审查自己的 MCP／插件／连接器权限。其他宿主只需注册相同的 handler 接口。

## 公开资源

根目录保留 GitHub 原有 MIT 许可证并合并初始化历史；Gitee 与 GitHub 主线通过非强推同步。SDK 以 tarball 提供，资源集中在 GitHub Releases，双仓库文档引用同一下载与 SHA-256。

公开 Android 默认使用原创代码占位形象，准备时删除旧私有构建的模型、Core 和派生头像。检查器解压扫描资产与凭据，拒绝私有模型包。Mac 公开 App 不带个人工程路径，首次启动由用户选择已配置工程；不替换当前安装。两个包保留项目与上游许可。

当前 APK 仍是 OpenClaw 传输参考，通用手机连接层尚未迁移。手机收音、播报、打断、GPU、后台和节点操作等待真机验收。历史文档中的私有本机人物构建记录不等于公开资源的分发范围。
