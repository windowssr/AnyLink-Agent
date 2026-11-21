# V0.2 Mac 边缘架构实机验收

日期：2026-11-22，Asia/Shanghai。本记录对应真实原生 Mac OpenClaw、ywc 模型代理和同一 PostgreSQL 记忆库，不复用 V0.1 云端 Agent 的成功结果。

## 实际运行位置

- Mac：原生 OpenClaw `2026.11.6 (06afb10)`，独立 Node `24.22.3`，本机 Gateway / 会话 / 工具循环 / Control UI / AnyLink memory 插件。
- 本机入口：`http://127.0.0.1:18791/`，仅 loopback；启动命令 `node mac/cli.mjs open` 自动在默认浏览器完成本机认证。
- 本机工具目录：`/Users/yundongwu/self-program/anylink-agent/data/mac/workspace`。
- 云端：仅 app / postgres 两个运行服务，直连 `https://api.deepseek.com/v1`；旧 `anylink-agent-openclaw-1` 为 exited，restart policy 为 no，历史数据未删除。
- 原生依赖记录在 `mac/runtime-lock.json`，599 个 lock 条目；在独立目录执行离线 dry-run 验证安装计划成功。官方 OpenClaw 包 SHA512 已与 npm 元数据比对通过。

## 自动检查

类型检查、构建、Shell / JavaScript 脚本检查通过。云端生产依赖 `npm audit --omit=dev` 为 0 个已知漏洞；该结果不冒充整个上游 OpenClaw 生态的漏洞审计。

15 项服务 / 插件测试通过：稳定请求摘要、scope 校验、主人与设备身份、凭据只保存摘要、来源设备、写幂等、revision 冲突、删除失效、模型 schema 与工具结果透传、SSE / 用量、上游错误与断流不重发、单设备并发、撤销、服务重启隔离，以及本地插件的本轮显式记忆写入权限。

测试连接独立 `anylink_test` 数据库。为排除 SSH 数据库隧道断开的影响，最终在 ywc 同一项目网络中以临时 Node 24 容器、当前编译代码和可控模型替身运行，15/15 通过，约 3.1 秒；临时容器自动移除，未使用产品库做 DROP / 重置。

检查发现并修复了流结束竞态：代理先落库终态、释放并发名额，再向 harness 发出 DONE，避免本地工具下一轮误判模型仍忙。中断流也先保存 submission_unknown 再关闭响应。

## 真实本机闭环

`node mac/acceptance.mjs` 的报告为 `artifacts/edge-acceptance-6b13537b.json`，8 项全部通过：

1. Mac 设备服务凭据访问云端模型和记忆身份。
2. 本机原生 OpenClaw 经自有代理调用真实 Flash，返回文本 SSE delta。
3. 同一本机会话正确引用上一轮内容，历史归本地 harness。
4. 使用 OpenClaw 原生文件工具写入并读取验收文件，本机文件内容与指定值精确一致。
5. 本地 Agent 使用记忆工具保存 global 事实，云端来源为认证 Mac。
6. 另一条全新本机会话召回该 global 事实。
7. 更正到 revision 2 后，本地下一轮读取到新内容。
8. 删除后，云端当前检索立即不再返回该事实。

报告开始于本地 02:17:04，结束于 02:17:42。首个原生聊天回合约 12.93 秒，后续短回合约 2.35～2.71 秒；文件多轮回合约 7.37 秒，保存记忆约 8.61 秒。这是完整回合的本次观测，不能当作首 token 延迟或长期性能保证。

本机验收文件为 `data/mac/workspace/anylink-proof-6b13537b.txt`，内容为 `Created by the native Mac OpenClaw 6b13537b`。文件保留作为可查看的执行证据。验收 global 事实已软删除，历史修订按数据政策保留，不冒充用户的长期偏好。

## 真实结果展示

通过本机 Control UI 的 Chat composer 实际发起文件读取，页面显示原生 Read 工具活动与文件完整内容。重启后再次打开 UI，结果仍可展示，截图为本地 `artifacts/edge-ui-result.png`。本地页面 pageerror 为 0，截图前确认页面未出现 Gateway 令牌。

该项验证实际浏览器 → 本地 Gateway → 原生工具 → 本地结果展示，非静态页面演示，也非云端执行器返回的固定文本。

## 重启与断线恢复

`artifacts/edge-recovery.json` 为 passed：

- 正常重启本机服务后，使用同一原生 session 可正确回答此前创建的文件名。
- 文件内容与 mtime 保持不变，未通过重做文件任务实现“恢复”。
- 主动中断专属 SSH 进程，本地 Gateway PID 未变化，health 与 UI 仍可用。
- SSH 自动重连后，云端设备身份恢复，Gateway 仍为原进程。

当前用户 LaunchAgent 为 `com.anylink.openclaw`，原生 Gateway 收尾完成后才关闭隧道；本机 launchd 实测停止预算为 60 秒，服务定义已与生效值对齐。更新或停止前先等本地任务收尾；本次验证空闲重启，不把它扩大成任意长任务停机保证。自动任务关闭，未启用语音、形象或主动联系。

这不等于已证明任意 GUI 点击、外部提交都具备 exactly-once。它们不在本次 Mac 基础能力的验收范围内。

## 云端发布与数据

模型与记忆服务内容首次验证于提交 `3964fcb1f5a29fb99ba99dc22541747d0777710a`，应用内容 / 配置指纹：`sha256:29d44067e8509fa32e01c35b53a2b8ac03739525ff49849efad89273891f98e2`。最终标签指向包含本记录与本机运行修正的提交，完整部署 SHA 由服务器 `current/manifest.json` 记录。

PostgreSQL 仍固定官方 16 系列 digest `sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb`。数据库迁移到版本 2，仅新增设备凭据摘要和模型元数据；旧事实、修订与历史数据保留。旧云端聊天 / 执行入口返回 410，不把旧待办转换为本机执行队列。

停用云端 Agent 后采样：app 约 47 MiB，PostgreSQL 约 39 MiB；宿主总内存 3499 MiB，available 约 1783 MiB。caststorage 的 MinIO、数据库与 Redis 均保持运行，未修改原有 Nginx 和业务服务。

## 秘密与边界

Git 跟踪文件中没有真实 DeepSeek Key 或本机服务凭据。使用真实值在服务器内部检查，app / 原 Gateway / PostgreSQL 日志及产品容器导出文件系统均无凭据匹配；本机服务 / 错误日志中的设备凭据与 Gateway Token 匹配数也为 0。检查只输出计数。

云端提供商 Key 没有传到 Mac。Mac 保存独立设备服务凭据与本地 Gateway Token，文件均为 0600。上游运行时会话在本机，模型代理只保存设备、状态、时长和 token 元数据。

Android、跨设备逐字会话同步、设备间任务协作、语音、虚拟形象、任意应用 GUI 操作仍属后续阶段。初始文件权限限定在配置工作区，进程操作沿用原生审批。
