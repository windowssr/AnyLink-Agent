# V0.1 实机验收记录

验收日期：2026-11-22（Asia/Shanghai）。部署主机：SSH 别名 `ywc`，Linux amd64。产品入口仅监听服务器 `127.0.0.1:3180`，通过 SSH 隧道访问。

## 已实现的交付范围

云端文字对话、单主人登录、全局和设备记忆、设备事实目录、修订与软删除、逻辑设备登记、待接入任务创建与取消，均已实现。每条会话有稳定 Gateway session，工具由产品服务校验、去重并持久化。

设备身份是主人手工声明的逻辑归属。没有真实 Mac / Android 执行器、可信配对、语音、虚拟形象或主动联系；任务保存为 `waiting_device`，不会执行设备命令。

## 版本与镜像

- OpenClaw：官方正式版 `2026.11.6`，镜像 `ghcr.io/openclaw/openclaw@sha256:65e229536a2698f0ab211c8a3d1c5c8e2685d19379d153e95f93ff76f22779cf`。
- PostgreSQL：独立官方 16 系列镜像，digest `sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb`。
- 模型：`deepseek/deepseek-flash`，Gateway 关闭默认 thinking；产品流每轮最多 2048 completion tokens。
- 数据库迁移：版本 1。
- 最终应用内容首次构建于提交 `4f2a7449b5e3b8080b40c41d36200e0a4baf0732`，内容和运行配置指纹为 `sha256:3dd5c99d230446311c33121236ca0a67aaac49e8bf824cecbabc81f169e1b21f`。
- 发布包含验收脚本与本记录，最终源码提交由 Git tag `v0.1.0` 指向。服务器 `current/manifest.json`、`release.env` 和 Compose 实际镜像标签记录完整部署提交。文档和运维脚本更新不改变上述应用文件系统。

## 自动检查与真实链路

`npm run check`、`npm run build`、Shell / Python 脚本语法检查通过。生产依赖 `npm audit --omit=dev` 返回 0 个已知漏洞。

独立 `anylink_test` PostgreSQL 数据库上的测试共 14 项通过。这里使用可控 Gateway 流式替身，覆盖鉴权与跨站写入、作用域、revision 冲突、幂等冲突、工具回传与去重、流中断、请求并发限制，以及重启后未完成请求隔离。测试不会使用或重建产品数据库。

服务器真实验收报告 `/opt/anylink-agent/backups/acceptance-live-02.json` 为 `passed: true`，9 项检查通过，全部聊天经产品 API → OpenClaw → DeepSeek：

1. 产品与依赖就绪；未登录读取产品数据返回 401；主人会话正常。
2. 两类逻辑设备正确声明执行器未接入。
3. 设备作用域隔离，记忆修订到 v2；旧 revision 返回 409；设备目录引用当前版本。
4. 真实 SSE 有文本 delta，最终请求为 completed。
5. 同一会话可正确回答上一轮要求的内容，验证稳定 session 路由与连续对话。
6. 模型通过真实多轮 function tool 保存全局记忆，来源设备由服务器记录；同一请求重放不重复保存。
7. 另一设备发起的新会话可召回已保存的全局事实。
8. 模型通过任务工具保留来源和目标设备，进入等待状态，并可取消；执行能力始终为 false。
9. 带 revision 条件的删除成功，读取返回 404，当前检索不再包含该事实。

首次验收中，测试客户端错误地给无 body 的 DELETE 加了 JSON Content-Type，导致框架拒绝请求。修正验收脚本后，完整第二轮独立运行全部通过。

## Web 验证

实际部署 Web 使用浏览器完成主人登录、对话 / 记忆 / 设备 / 任务页面切换及退出。1440、1024、768、700、390 像素五种宽度均无横向溢出，浏览器 pageerror 为 0。手机保留退出入口；设备卡片的记忆跳转按该设备筛选。

这项检查验证布局和基础导航；真实模型及 CRUD 行为由上面的产品 API 验收覆盖。没有把静态页面加载或模型替身当作真实 DeepSeek 成功证据。

## 持久化与发布恢复

重建本项目 app 和 PostgreSQL 容器后，真实会话、请求正文与结果、记忆修订 / 删除状态、任务和设备 API 快照完全一致。第一轮持久化快照 SHA256 为 `0df58ae284bd7139399a2267fbd18057f5cec70e64f8c4387e72cbace6c75071`。

每次发布前只备份本项目数据库。回退保留数据目录，未知请求启动时隔离为 `submission_unknown`，不会重新运行模型；后者另由独立数据库重启测试验证。

实际运行 `scripts/rollback.sh`，从 `4f2a7449b5e3` 回退到 `6a1837ea1160`，就绪检查通过；再次运行同一脚本恢复 `4f2a7449b5e3`。两次切换后，第二轮 2 台设备、4 条记忆（含已删除事实）、1 个任务、2 个会话及 5 个请求的持久字段快照保持一致，SHA256 为 `e329e8e582345b3f7a8cb17d1a2a560bf4a2c4709e19b32c9bb739c572768b45`。比较排除了只在进程内存在的 SSE 序号，未排除业务字段。

## 资源与隔离

原方案 Gateway 768 MiB 上限在启动阶段不足，1024 MiB 上限在首次真实推理中也发生 OOM / exit 137。实机最终采用 Gateway 1536 MiB、V8 old space 384 MiB / semi space 8 MiB，插件仅允许 deepseek，关闭 Control UI 和内建系统副作用入口；产品服务和 PostgreSQL 仍各限 256 MiB，聊天并发为 1。

真实模型负载后采样：Gateway 约 1020 MiB、app 91 MiB、PostgreSQL 34 MiB；宿主总内存 3499 MiB，available 约 903 MiB，无 swap。限额不等于常驻内存，后续增加设备执行、语音或并发前需要重新测量。

初次冷推理单独测得完整短回复约 14.64 秒；这是单次冷启动观测，不能当作首 token 延迟或持续性能指标。V0.1 不承诺零延迟语音对话。

宿主端口与 Docker PortBindings 检查确认：只有产品 Web 发布到回环 3180，项目数据库和 Gateway 均未发布宿主端口。原有 caststorage 的 MinIO、PostgreSQL、Redis 保持原容器运行，原有 3000 / 3101 服务、Nginx 与配置未被修改。

## 秘密与验收数据

真实凭据仅在服务器专属秘密文件中配置，文件 0600，目录 0700。Git 跟踪源码的真实 Key 格式扫描为 0；使用真实值在服务器内部比对，三个项目容器日志与产品容器导出文件系统均无凭据匹配。检查只输出计数，没有输出秘密。

验收报告与备份保留在服务器本项目 backups 目录，不进入 Git。测试实体使用随机后缀与报告中的明确 ID 定向清理；不清空产品表、不删除持久目录，也不清理其他项目的 Docker 资源。
