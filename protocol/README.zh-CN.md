# AnyLink 交互协议 v3 (`3.0`)

[English](README.md) · [OpenAPI 3.1](openapi.json) · [TypeScript SDK](../sdk/README.md) · [Python SDK](../sdk-python/README.md) · [MCP 适配器](../mcp/README.md)

AnyLink 是面向**个人 Agent 网络（Personal Agent Network）**的引擎无关交互协议：

- **边缘自治**：每台设备（Mac、Linux、Windows、Android、服务器或脚本）只需管好自己所在的本地环境与安全边界，无需事先维护其他设备的能力清单。
- **云端统一模型网关**：多模型、多提供商 OpenAI 兼容透传，按 Agent 并发控制，并支持可选的自动共享记忆注入开关（`X-AnyLink-Auto-Memory: on`）。
- **云端记忆大脑（Cloud Memory Brain）**：统一调度与管理跨设备记忆——混合检索与上下文组装（`POST /edge/v1/memory/assemble`）、对话与任务事件异步摄入（`POST /edge/v1/memory/ingest`）、LLM 驱动的提取/去重/合并/作用域分配，以及**跨设备能力边界自动学习**。
- **无能力前置约束的跨设备调用**：边缘 Agent 直接按目标设备或 Agent 发送意图/任务；若目标设备无法完成，由目标 Agent 返回 `declined`（或 `failed`）并说明原因，云端记忆大脑自动将其沉淀为设备边界记忆，后续各设备加载上下文后自然避开无效派发。
- **实时 WebSocket 双向通道（`GET /edge/v1/ws`）**：毫秒级任务推送、实时进度流、租约心跳防卡死、任务完成主动回调通知发起方，并完整保留 HTTP 降级接口。

## 1. 身份与接入

身份层级：`主人 (Owner) → 设备 (Device) → Agent`。

1. **接入（`POST /edge/v1/connect`）**：携带 `Authorization: Bearer <ANYLINK_JOIN_KEY>`，提交 `device: { install_id, name, platform, slug? }` 与 `agent: { key, name, kind?, summary? }`。`slug` 为唯一短别名（如 `home-mac`、`gpu-box`，省略时自动生成唯一短别名），用于消除同名设备歧义。返回 `201`、`device_slug`、一次性 `ak_` 令牌与 `protocol: { name: "anylink", version: "3.0" }`。同一 `(install_id, agent.key)` 重连保留原 ID 并轮换令牌。
2. **协议协商（`GET /edge/v1/protocol`，兼容别名 `GET /edge/v1/link/protocol`）**：返回 `version: "3.0"`、传输端点与路由模式（含 `device_slug`）。
3. **节点与设备简介（`PATCH /edge/v1/agent/profile`、`PATCH /edge/v1/device/profile`）**：可选更新 Agent 简介或设备名称 / 唯一短别名 `slug`（纯标识信息，不作为任务准入门槛）。

## 2. 云端记忆大脑

- **作用域**：`global`（跨设备共享）、`device`（单设备有效，仅本设备或主人可改删）、`agent`（单 Agent 私有）。
- **记忆类别（`kind`）**：`fact`（事实）、`preference`（偏好）、`boundary`（设备能力边界）、`episode`（事件摘要）。
- **`POST /edge/v1/memory/assemble`**：根据当前 `query`、设备/Agent 身份与预算，综合中英文分词匹配 + 可选向量相似度 + 时间衰减 + 重要度，返回相关长期记忆、跨设备近期事件摘要、设备能力边界及可直接拼入系统提示词的 `summary_text`。
- **`POST /edge/v1/memory/ingest`**：边缘上报对话轮次、任务结果或观察记录；内置**短闲聊过滤**（如“好的/你好”直接跳过不消耗模型）与**按会话去抖批处理**（默认窗口 15 秒 / 满 6 条自动合并为单次云端记忆 Agent 调用；跨设备拒绝/失败边界会立即整理落盘，未配置模型密钥时自动降级为确定性摘要与边界记录）。
- **`GET /edge/v1/context` & 显式记忆 CRUD**：保留三层快照与显式增删改查（含 `expected_revision` / `If-Match` 乐观锁与幂等键）。

## 3. 云端模型网关

- **`GET /model/v1/models`**：列出已配置的模型与别名（如 `default`、各提供商模型）。
- **`POST /model/v1/chat/completions`**：标准 OpenAI 兼容 JSON / SSE 流式转发，不再写死单一模型，改为按 Agent 并发控制。
  - **可选自动记忆模式（1A）**：携带请求头 `X-AnyLink-Auto-Memory: on`（或服务端开启 `ANYLINK_AUTO_MEMORY_DEFAULT=true`），网关会在推理前自动组装共享记忆注入上下文，并在回复完成后异步摄入记忆大脑。
- **`POST /model/v1/speech`**：可选语音播报端点，口播改写风格默认中性，可按需配置，不再绑定特定展示角色。

## 4. 跨设备任务与 WebSocket 实时总线

状态机：`queued` → `running`（带 `lease_expires_at` 租约）→ `succeeded` | `failed` | `declined` | `cancelled` | `unknown` | `expired`（运行中取消为 `cancel_requested`）。

- **创建任务（`POST /edge/v1/tasks`，兼容 `POST /edge/v1/link/tasks`）**：支持 `target` 为 `{ agent_id }`、`{ device_id }`、`{ device_slug }`（推荐唯一短别名）、`{ device_name }`（同名冲突时返回 `409 AMBIGUOUS_TARGET_DEVICE` 并列出候选 slug）、`{ agent_key }` 或省略；只需提供自然语言 `instruction`（或结构化 `capability` + `input`），不再因缺少能力声明而 409 拒绝。
- **拒绝与自动学习**：接收方发现自己环境做不到时，回传 `state: "declined"` 与 `error: { code, message }`，云端记忆大脑自动提炼为 `boundary` 记忆并在后续上下文中生效。
- **WebSocket（`GET /edge/v1/ws`）**：连接后服务端实时维护在线状态；新任务立即通过 `task.available` 下推，Worker 回复 `task.claim` 原子领取，执行中发 `task.heartbeat` 续租与 `task.progress` 推送进度，完成后发 `task.result`，服务端立即通过 `task.completed` 主动通知发起方。断线超租约的任务由服务端自动置为 `unknown`（`LEASE_EXPIRED`），绝不永久卡死、绝不盲目重跑副作用。
