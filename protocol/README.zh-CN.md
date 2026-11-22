# AnyLink 接入协议 v2

[English](README.md) · [OpenAPI 3.1](openapi.json) · [JavaScript／TypeScript SDK](../sdk/README.zh-CN.md)

协议连接应用、Agent 和设备，不规定使用哪一个大模型框架、界面或系统工具。云端按三层作用域存储事实、可选转发模型请求，并在 Agent 之间路由任务；每台宿主负责执行、审批和本地策略。OpenClaw 是参考实现，Codex 或其他项目都可以编写相同宿主接口的适配器。

## 连接和身份

远程连接使用 HTTPS，或受保护的本机隧道。身份层级为 主人 → 设备 → Agent：一台设备可承载多个 Agent，路由和 Agent 级记忆在 Agent 粒度隔离。

`POST /edge/v1/connect` 使用 `Authorization: Bearer <加入密钥>` 接入——加入密钥是保存在服务器上的主人密钥 `ANYLINK_JOIN_KEY`。请求体给出安装标识（`device.install_id`）、设备和一个 Agent 键；服务器对两者执行 upsert 并返回新的 `ak_` 凭据及 `protocol.version` `2.0`。用同一安装与 Agent 键重连会返回相同 ID 并轮换凭据，旧令牌立即失效。没有逐对授权步骤：任何持有加入密钥的设备都能共享上下文并向任意 Agent 派发任务。旧版主人签发的 `/v1/devices/{id}/credential` 凭据仍然有效，绑定该设备的 `default` Agent。

其余请求使用 `Authorization: Bearer <Agent 凭据>`。凭据按 Agent 吊销；模型提供商 Key 保留在服务器。Agent 是逻辑身份，不是硬件认证。当前参考服务是单主人部署，不是开放多租户平台。加入密钥权限很大：持有者可以连接并向任意 Agent 派发任务，请把它保存在服务器密钥中，并通过 HTTPS 为客户端服务。

`GET /edge/v1/link/protocol` 返回 `anylink`、版本 `2.0`、投递语义和 `agent`、`device`、`capability` 三种路由方式。当前属于预览实现；不兼容修改应升级协议路由／版本，新增字段不应强制替换宿主 Agent。

## 上下文、人设和模型

`GET /edge/v1/context` 返回 `device_id`、`agent_id`、三层记忆（`global`、`device`、`agent`，各限 30 条）、已配置的人设文档 `persona`，以及带 revision 的设备目录。`GET /edge/v1/persona` 单独返回人设（未配置时 `404 PERSONA_NOT_CONFIGURED`）。

记忆作用域：`global` 事实所有人共享；`device` 事实适用于一台设备，该设备上所有 Agent 可见；`agent` 事实只属于一个 Agent——同设备的其他 Agent 不能搜索、读取、修订或删除。边缘调用方写 `scope:'agent'` 时始终绑定自己的 Agent（否则 `403 AGENT_SCOPE_FORBIDDEN`）；主人调用方需提供 `applicable_agent_id`，适用设备由 Agent 推导。记忆修改需要由接入应用确认保存意图、保留幂等键并满足 revision 前置条件；修订要求 `expected_revision`，删除要求 `If-Match`。删除事实不再进入当前检索。这属于应用记忆，不是模型权重训练。

`POST /model/v1/chat/completions` 是可选的 OpenAI Chat Completions 兼容透传，保留 SSE 工具调用片段和 `[DONE]`。参考服务当前提供 DeepSeek Flash。云端不运行工具或 Agent 循环，宿主也可以继续使用自己的模型与账号。

## 能力与任务流程

1. 每个 Agent 向 `/edge/v1/link/capabilities` 声明能力，例如 `text.reverse` 加说明。能力清单属于 Agent，不属于设备。
2. `GET /edge/v1/link/directory` 按设备列出全部在线 Agent、能力、基于 `last_seen_at` 的 `online`（60 秒）和 `self` 标记。`GET /edge/v1/link/peers` 保留为按设备聚合的兼容视图（已弃用）。
3. 来源向 `/edge/v1/link/tasks` 提交 `capability`、`input`、可选 `ttl_seconds`（10–86400 秒，默认 1800）和可选 `target`：`{agent_id}` 精确路由到该 Agent，`{device_id}`（或旧字段 `target_device_id`）路由到该设备上任一具备能力的 Agent，不指定 target 则由任意具备能力的 Agent 领取。路由解析要求存在声明该能力的在线 Agent，否则返回 `409 NO_TARGET_AGENT`。来源身份取自认证，不能通过 JSON 冒充。
4. 任意 Agent 调用 `/edge/v1/link/tasks/claim`。服务器先把过期的可路由任务置为 expired，再原子领取一个调用方声明了该能力的排队任务，优先 agent 定向、其次设备定向、最后不限定。来源 Agent 必须仍然存在（其凭据可以已轮换）。空结果返回 `task:null`。已运行任务不自动重排。
5. 宿主先记录持久执行回执，再检查自己的参数、工作区、工具权限和审批，执行已注册处理器。
6. 领取方 Agent 向 `/edge/v1/link/tasks/{id}/result` 提交真实结果；只有它能提交。来源、目标和领取方都能读取任务；只有来源 Agent 可以取消。

```json
{
  "target": { "agent_id": "00000000-0000-4000-8000-000000000003" },
  "capability": "text.reverse",
  "input": { "text": "AnyLink" },
  "ttl_seconds": 1800
}
```

```json
{"state":"succeeded","output":{"text":"kniLynA"}}
```

状态包括 `queued`、`running`、`cancel_requested`、`succeeded`、`failed`、`cancelled`、`unknown`、`expired`。来源 Agent 可以取消排队任务，或请求协作中断。请求取消不证明外部操作已停止；已经完成的真实成功仍可回传。未知结果需检查，不能默默重跑。吊销 Agent 会使其凭据失效、其 agent 定向的排队任务不再可领取，但不撤销已发生的副作用。

输入和结果对象各限制 64 KiB；任务列表只返回来源／目标最近 100 项，分页和任务事件流暂未实现。云端管理员能够读取任务内容和回执。

## 幂等与恢复

状态修改需要由调用方保留的幂等键，作用域包含认证 Agent 和操作。原键原内容返回历史结果，原键不同内容返回 409；新一次领取使用新键；空领取不持久占用键，只有实际领取任务才持久记录结果。`connect` 和凭据签发刻意不做幂等缓存，因为它们返回一次性密钥。

SDK 不自动重试模型或未知请求。保留执行 journal：已完成的结果可以用原结果键重发；只有 `started`、没有结果的记录是未知结果，需要人工或宿主明确核对，不能自动执行第二次。这里保证一次领取与持久去重，不承诺外部系统绝对“恰好一次”。

## 接入自己的项目

[OpenAPI](openapi.json) 从服务器 schema 生成，`npm run protocol:check` 检查漂移。其他语言可以直接实现 HTTP 客户端；宿主接口是能力名加 `execute(input, {task, signal})`。形象、语音、会话和审批事件放在各自适配层。

随附的 Android／Mac 软件目前仍使用主人签发的设备凭据（绑定各设备的 `default` Agent），尚未调用 `connect`，也尚未改造成通用手机控制器。Codex 示例启动独立的只读 CLI 任务；控制现有桌面会话需要单独对接受支持的 app-server／会话接口。MCP 可以给 Agent 提供记忆和工具，单独安装 MCP 工具不会自动产生手机到 Agent 的入站控制通路。

## 各设备独立运行

每台设备用加入密钥（或旧版主人凭据）连接 AnyLink 服务器，并在本机按 Agent 管理会话和工具循环。Android 0.3+ 不再连接 Mac Gateway。`client.directory()`／`GET /edge/v1/link/directory` 发现在线 Agent 与能力；`client.peers()` 保留给旧客户端。`last_seen_at` 是凭据活动，不是 Worker 在线保证。其他项目可独立实现该 HTTP 协议，无需 OpenClaw 或参考形象界面。
