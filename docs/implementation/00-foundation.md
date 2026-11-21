# V0.1 实施基线

## 范围与总设计的差异

首版为单主人、SSH 隧道访问的云端闭环。原生客户端、设备密钥配对、真实执行、语音和形象留待后续。来源设备只是用户声明，数据中标记 `owner_statement_declared_device`，不能作为执行授权。

产品 API 使用 REST 和请求级 SSE；完整设计的持久 WebSocket 领域事件暂不实施。当前事实直接查 PostgreSQL，设备目录是当前有效事实的投影，不引入向量服务和异步摘要。

## 运行与数据

三服务为 app、openclaw、postgres。app 只发布到宿主 `127.0.0.1:3180`，其他服务没有宿主端口。Gateway 用官方 `2026.11.6`，上游 OCI index digest 为：

```text
sha256:65e229536a2698f0ab211c8a3d1c5c8e2685d19379d153e95f93ff76f22779cf
```

产品库保存逻辑设备、记忆与修订、任务、请求去重和 Gateway 返回的响应投影。响应投影用于页面恢复，不提供另一套可编辑的会话历史。Gateway 持有实际 agent session；内部请求指定稳定的 `x-openclaw-session-key`。

使用 PostgreSQL 会话级 advisory lock 约束单个服务实例；消息准入另用事务锁，限制一个活动请求。重启时把未结束请求标为 `submission_unknown`，不自行重发。每个工具结果在业务事务中按请求与 tool_call_id 去重。

## HTTP 接口

| 接口 | 行为 |
| --- | --- |
| `POST /v1/auth/login` | 主人令牌换取 HttpOnly、SameSite=Strict 会话 |
| `POST /v1/auth/logout` | 撤销当前会话 |
| `GET /v1/status` | 已登录用户读取版本与能力范围 |
| `GET/POST /v1/devices` | 列表 / 登记逻辑设备 |
| `GET /v1/devices/:id/memory-directory` | 当前设备事实引用与版本 |
| `GET /v1/memories` / `POST /v1/memories/search` | 当前有效事实，结构化和子串过滤 |
| `POST /v1/memories` | 显式创建事实 |
| `GET/PATCH/DELETE /v1/memories/:id` | 读取 / revision 条件修订 / 删除 |
| `GET /v1/memories/:id/revisions` | 有效记忆的修订历史 |
| `GET/POST /v1/tasks` | 列表 / 保存待接入任务 |
| `GET /v1/tasks/:id` / `POST /v1/tasks/:id/cancel` | 查询 / 取消 |
| `GET/POST /v1/conversations` | 会话列表 / 新建 |
| `GET /v1/conversations/:id` | 请求和响应读投影 |
| `POST /v1/conversations/:id/messages` | 返回 202、request_id 和事件地址 |
| `GET /v1/requests/:id` / `GET /v1/requests/:id/events` | 状态 / SSE |
| `GET /healthz` / `GET /readyz` | 进程存活 / DB 与 Gateway 就绪 |

创建、修订、删除、取消和消息写入要求 Idempotency-Key。消息键必须等于 body.request_id。记忆 PATCH 带 expected_revision，DELETE 带 If-Match。登录与登出不要求幂等键，搜索为无副作用查询。

## 工具与记忆

对模型只提供 anylink_* 记忆 / 任务 / 设备工具。记忆写工具只有在明确“记住 / 更正 / 遗忘”等请求，或显式授权本条记忆写入时才暴露。所有工具参数通过 Zod 校验；owner 和来源由服务端上下文决定。

先保存事实再确认“记住了”；更正记录不可变修订；删除后在线检索与设备目录立即过滤。历史聊天仍可能包含原始陈述，删除事实不承诺删除所有历史。

## 错误与恢复

上游 HTTP 错误、丢失 DONE、超时、工具轮次超限或服务重启均保守地标记 submission_unknown。客户端显示已知部分并提示核对，不自动重复请求。SSE 断开可以重连获取当前快照，但不会启动新模型运行。

模型请求最长 120 秒、最多 6 轮工具回传；服务端长期凭据不进入客户端。生产访问仅限 SSH 转发，不把内部 Gateway HTTP 端点发布到公网。
