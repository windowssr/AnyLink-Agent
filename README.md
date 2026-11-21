# AnyLink Agent

目标是一个运行在边缘设备上的个人助理：用户与 Mac / Android 本地成熟 harness 交互，服务器提供共享记忆和模型 API 代理。

**架构已于 2026-11-22 校正。** 下文是已部署 `v0.1.0` 云端原型的运行说明，不能作为后续 Mac 接入方案。当前目标见 [边缘 Agent 设计](docs/product/README.md) 与 [Mac 接入施工基线](docs/implementation/03-edge-mac-plan.md)。

已部署 V0.1 提供云端文字交流、全局 / 设备记忆、逻辑设备管理和待办任务；尚未接入 Mac 本地 harness。旧发布 tag 与验收结果保留，不改写为新架构成功证据。

**当前设备执行器尚未接入。** 设备是手工登记的逻辑设备，任务仅保存为 `waiting_device`，不会操作电脑或手机。

## 已部署 V0.1 原型架构

```text
浏览器 → SSH 隧道 → AnyLink Web / API → OpenClaw → DeepSeek Flash
                            └───────→ 独立 PostgreSQL
```

TypeScript / Fastify / React；Docker Compose 三服务。OpenClaw 固定 `2026.11.6` 官方镜像 digest。模型为 `deepseek/deepseek-flash`，长期事实仅在产品库写入；OpenClaw 内置记忆写入与系统副作用工具关闭。

## 使用已部署服务

```bash
ssh -N -L 3180:127.0.0.1:3180 ywc
```

打开 <http://127.0.0.1:3180>。在自己的终端读取主人访问令牌：

```bash
ssh ywc 'cat /opt/anylink-agent/secrets/owner-token'
```

此处需要的是产品访问令牌，不是 DeepSeek Key。不要把任何真实凭据提交到仓库。

登录后可以按这个顺序开始：在“设备”登记自己的 Mac 和 Android；在“对话”选择来源设备；发送“记住，我喜欢简洁的中文回复”，然后在“记忆”核对保存结果。全局事实可跨设备使用，设备事实绑定所选适用设备。创建任务时选择目标设备，当前任务会明确等待执行器接入。

## 本地开发

需要 Node 22.12+（生产镜像 Node 24.22.3）、PostgreSQL 16 和已配置的 OpenClaw。复制 `.env.example` 到被忽略的 `.env`，填写本地开发配置。

```bash
npm ci
npm run check
npm run build
node --env-file=.env dist/server/index.js
```

如需界面热更新，API 在一个终端运行 `APP_ORIGIN=http://127.0.0.1:5173 node --env-file=.env --import tsx --watch server/index.ts`，另一终端运行 `npm run dev:web`，使用 `http://127.0.0.1:5173`。origin 必须与浏览器地址一致，否则跨站写保护会拒绝登录和修改请求。数据库启动时自动执行版本 1 迁移；服务只允许一个活动运行实例。

## 检查与测试

```bash
npm run check
npm test
npm run test:integration
```

集成测试必须连接独立的 `anylink_test` 数据库；传入 `TEST_DATABASE_URL`，或在被忽略的 `secrets/integration.json` 保存 `database_url`。测试会重建此测试库的 public schema，明确拒绝其他数据库名；不要使用产品库凭据。

集成测试使用真实 PostgreSQL 和可控 Gateway 流式替身，覆盖鉴权、作用域、revision、幂等、工具循环、断线与重启。真实 DeepSeek 验收独立记录，不把替身测试当作真实模型证明。

## 部署与回退

在已提交的干净工作树上构建：

```bash
bash scripts/build-release.sh
bash scripts/deploy.sh artifacts/COMMIT前12位 ywc
bash scripts/rollback.sh ywc
```

部署包不包含秘密。服务器必须预先准备项目独立的秘密文件；详细步骤见 [运维说明](docs/implementation/01-operations.md)。部署只操作 `anylink-agent` Compose 项目，数据库和 Gateway 状态保留在项目数据目录。

## 文档

- [V0.1 实施与接口](docs/implementation/00-foundation.md)
- [部署、秘密与回退](docs/implementation/01-operations.md)
- [V0.1 实机验收记录](docs/implementation/02-validation.md)
- [Mac 边缘 Agent 接入施工基线](docs/implementation/03-edge-mac-plan.md)
- [整体产品设计文档集](docs/product/README.md)

后续：可信设备绑定、持久设备回执与执行器、虚拟形象、语音和主动联系。它们不计入当前版本的已实现能力。
