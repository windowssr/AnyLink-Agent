# Agent Mesh v2：加入密钥、Agent 路由与三层记忆

修订：2026-11-23。分支 `feat/agent-mesh-v2`，协议 2.0，服务 0.5.0，SDK 0.2.0，Android 0.4.0-preview.1。取代第 19 篇中的逐对授权（grants）部分。

## 决策

- 任何 Agent 持主人加入密钥调用 `POST /edge/v1/connect` 即可接入；不再有 source→target→capability 授权，`link_grants`、`link_capabilities` 已删除。真正的执行边界是各宿主本地策略（例如 Mac `files.search` 的根目录）。撤销 Agent／设备是紧急关停，不是使用前审批。
- 身份为 owner → device → agent。设备按客户端 `install_id` 去重，Agent 按 `(device_id,key)` 去重；重连轮换 token。旧的主人签发凭据挂到设备的 `default` Agent，继续可用；`POST /edge/v1/device/install-id` 让旧设备认领 install_id，加入后保留原设备与设备记忆。
- 任务按 agent／device／capability 三级路由，领取顺序为指定 Agent → 指定设备 → 不限设备；保留至多一次领取、不重排队、unknown 不重试。`/edge/v1/link/directory` 列出设备、Agent、能力与在线状态（60 秒内有活动）。
- 记忆分 global／device／agent；agent 层只有该 Agent 可见可改。`/edge/v1/context` 同时下发服务器人设 `persona/dafeiyu.md`（改编自 dsh-whale-musume-persona，MIT）。

## 客户端

- Mac：`node mac/connect.mjs --server URL --join-key-file FILE --ssh-host ywc` 在同一设备上接入 `mac-openclaw` 与 `mac-files` 两个 Agent；已有安装只改凭据文件，不重写 OpenClaw 配置。OpenClaw 插件新增目录与任务工具；`configure-companion.mjs` 用共享人设＋宿主补充生成 SOUL.md（v0.6 迁移，有备份）。
- Android：服务器地址＋加入密钥接入为 `android-dafeiyu`；系统提示＝服务器人设＋`android-native/persona.md`＋三层记忆；前台时作为任务目标提供 `phone.status`、`companion.say`，执行前写 journal，中断不重跑。`npm --prefix android-native run build:private` 生成带大肥鱼 Live2D 的自用 `-private` APK，公开发布脚本拒收。

## 部署记录（ywc）

- 2026-11-23 加入密钥写入 `/opt/anylink-agent/secrets/app.env`（`ANYLINK_JOIN_KEY`，备份 `app.env.before-join-key`）；依次部署 ca86c2b、f749990、a84f423，每次部署前自动 pg_dump 备份。v4 迁移后旧 Android 凭据验证可用。
- 首次部署时配置正则把任何加入密钥都当成空值（JOIN_DISABLED），a84f423 修复。失败的那次 Mac 加入已认领 install_id 但未写回本机，已对该 Mac 设备单行清空 install_id 后重新加入。
- 端到端验证：临时 SDK Agent 无授权按 agent_id 派发 `files.search` 到 `mac-files`，回执 succeeded；之后撤销临时设备和 Mac 的旧 `default` Agent。

## 待真机验证

私有 APK 的 Live2D 只在软件 GL 浏览器预览中确认渲染；手机 GPU、TTS、前台 Worker 与 `companion.say` 需要安装到真机后验收。
