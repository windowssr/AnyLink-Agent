# AnyLink 接入协议 v1

[English](README.md) · [OpenAPI 3.1](openapi.json) · [JavaScript／TypeScript SDK](../sdk/README.zh-CN.md)

协议连接应用、Agent 和设备，不规定使用哪一个大模型框架、界面或系统工具。云端存储事实、可选转发模型请求并中继已授权任务；目标宿主负责执行和审批。OpenClaw 是参考实现，Codex 或其他项目都可以编写相同宿主接口的适配器。

## 连接和身份

远程连接使用 HTTPS，或受保护的本机隧道。请求使用 JSON 和 `Authorization: Bearer <设备凭据>`。主人通过 `/v1/devices/{id}/credential` 一次性颁发凭据，模型提供商 Key 保留在服务器。设备是逻辑身份，不是硬件认证。当前参考服务是单主人部署，不是开放多租户平台。

`GET /edge/v1/link/protocol` 返回 `anylink`、版本 `1.0` 及支持的通路。当前属于预览实现；不兼容修改应升级协议路由／版本，新增字段不应强制替换宿主 Agent。

## 记忆和模型

`GET /edge/v1/context` 返回 `device_id`、`global`、`device` 及带 revision 的设备目录。由接入应用确认保存意图后写记忆，所有修改保留幂等键；修订要求 `expected_revision`，删除要求 `If-Match`。删除事实不再进入当前检索。这属于应用记忆，不是模型权重训练。

默认上下文选择全局及当前设备事实；旧记忆接口允许同一主人信任域内显式跨设备查询和写入，不应宣传为设备之间的数据强隔离。

`POST /model/v1/chat/completions` 是可选的 OpenAI Chat Completions 兼容透传，保留 SSE 工具调用片段和 `[DONE]`。参考服务当前提供 DeepSeek Flash。云端不运行工具或 Agent 循环，宿主也可以继续使用自己的模型与账号。

## 能力、任务、执行回执

1. 目标设备向 `/edge/v1/link/capabilities` 声明能力，例如 `text.reverse`。
2. 主人在 `/v1/link/grants` 为“来源设备 → 目标设备 → 能力”授权。声明能力本身不会自动授权。
3. 来源向 `/edge/v1/link/tasks` 提交 `target_device_id`、`capability`、`input` 和可选 `ttl_seconds`（10–86400 秒，默认 1800）。来源身份取自认证，不能通过 JSON 冒充。
4. 目标调用 `/edge/v1/link/tasks/claim`。服务器原子检查当前授权、目标能力与来源凭据，只领取一个排队任务；空队列返回 `task:null`。已运行任务不自动重排。
5. 宿主先记录持久执行回执，再检查自己的参数、工作区、工具权限和审批，执行已注册处理器。
6. 目标向 `/edge/v1/link/tasks/{id}/result` 提交真实结果。来源和目标才能查询，只有目标可以提交结果。

```json
{
  "target_device_id": "00000000-0000-4000-8000-000000000002",
  "capability": "text.reverse",
  "input": { "text": "AnyLink" },
  "ttl_seconds": 1800
}
```

```json
{"state":"succeeded","output":{"text":"kniLynA"}}
```

状态包括 `queued`、`running`、`cancel_requested`、`succeeded`、`failed`、`cancelled`、`unknown`、`expired`。来源可以取消排队任务，或请求协作中断。请求取消不证明外部操作已停止；已经完成的真实成功仍可回传。未知结果需检查，不能默默重跑。撤销授权阻止后续领取，不撤销已发生的副作用。

输入和结果对象各限制 64 KiB；任务列表只返回来源／目标最近 100 项，分页和任务事件流暂未实现。云端管理员能够读取任务内容和回执。

## 幂等与恢复

状态修改需要由调用方保留的幂等键，作用域包含认证设备和操作。原键原内容返回历史结果，原键不同内容返回 409；新一次领取使用新键；空领取不持久占用键，只有实际领取任务才持久记录结果。

SDK 不自动重试模型或未知请求。保留执行 journal：已完成的结果可以用原结果键重发；只有 `started`、没有结果的记录是未知结果，需要人工或宿主明确核对，不能自动执行第二次。这里保证一次领取与持久去重，不承诺外部系统绝对“恰好一次”。

## 接入自己的项目

[OpenAPI](openapi.json) 从服务器 schema 生成，`npm run protocol:check` 检查漂移。其他语言可以直接实现 HTTP 客户端；宿主接口是能力名加 `execute(input, {task, signal})`。形象、语音、会话和审批事件放在各自适配层。

当前附带的 Android／Mac 软件仍使用 OpenClaw 参考传输，尚未改造成通用手机控制器。Codex 示例启动独立的只读 CLI 任务；控制现有桌面会话需要单独对接受支持的 app-server／会话接口。MCP 可以给 Agent 提供记忆和工具，单独安装 MCP 工具不会自动产生手机到 Agent 的入站控制通路。
