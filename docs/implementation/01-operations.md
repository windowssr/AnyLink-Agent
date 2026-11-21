# 部署、秘密与回退

## 服务器目录

`/opt/anylink-agent` 下使用 releases、current、previous、data、secrets 和 backups。应用为非 root 容器用户；秘密目录仅宿主 root 可读。配置文件只包含环境变量引用，不包含真实模型 Key。

现有业务容器、端口、Nginx 配置与数据库不参与本项目。不能运行全局 Docker 清理或删除产品持久目录。

## 秘密文件

| 文件 | 内容 |
| --- | --- |
| `secrets/gateway.env` | DEEPSEEK_API_KEY、OPENCLAW_GATEWAY_TOKEN |
| `secrets/app.env` | DATABASE_URL、OWNER_TOKEN、GATEWAY_TOKEN、内部 URL、监听和 origin |
| `secrets/postgres.env` | 独立库的 POSTGRES_DB、POSTGRES_USER、POSTGRES_PASSWORD |
| `secrets/owner-token` | 主人登录令牌，供用户通过 SSH 读取 |

文件权限 0600，目录 0700。令牌与密码分别随机生成，不复用 DeepSeek Key。秘密不进入 Git、镜像、release.env、manifest 和日志。

## 发布

1. 本地完成类型检查、构建和独立数据库集成测试，提交到 main。
2. build-release 在干净提交上构建 linux/amd64 产品镜像；生产依赖在本机按 lock 完整性校验后离线打包，拒绝宿主原生二进制。
3. 生成镜像包、Compose、Gateway 配置、release.env、commit manifest 和 SHA256SUMS。
4. deploy 经 SSH 传入 releases/commit，校验 hash，导入镜像。
5. remote-up 在已有产品数据库运行时先 pg_dump，再更新本项目三个服务。
6. 健康检查通过后更新 current；旧版本写入 previous。
7. 完成真实模型和持久化验收后，才创建并推送正式 tag。

低内存服务器不编译 OpenClaw。若本机下载链路不稳定，允许服务器直接下载同一 digest 的官方预构建镜像；这不改变版本或构建源码。不要依赖未经验证的同名第三方镜像。

默认部署包只包含产品镜像，上游固定镜像在服务器已有时复用，否则从官方 registry 拉取。需要完全离线部署时设置 `BUNDLE_UPSTREAM=1`，把上游镜像一并打包。当前服务器的 PostgreSQL 官方镜像已缓存，Gateway 使用官方 GHCR 下载。

Gateway 使用显式官方 CLI 入口，避免镜像的自动 doctor 修复适配器在非交互环境反复运行。运行期配置放在 UID 1000 可写的专属状态目录，发布文件仍不含秘密；启用单进程启动和编译缓存。此调整不修改 OpenClaw 源码或放宽其运行期权限。

实机初始 768 MiB Gateway 上限出现 Docker OOM / exit 137，因此调整为 1024 MiB，并将插件 allowlist 收窄到 deepseek、关闭内部 Control UI。产品服务和数据库仍各为 256 MiB；仅产品 Web 发布到宿主回环地址。

## 查看状态

```bash
ssh ywc 'cd /opt/anylink-agent/current && docker compose --project-name anylink-agent --env-file release.env -f compose.yaml ps'
ssh ywc 'curl -fsS http://127.0.0.1:3180/readyz'
```

日志仅输出错误分类和请求关联信息。排障时不要打印 env_file、完整 Docker inspect 环境或模型请求头。

## 回退

运行 `bash scripts/rollback.sh ywc`，重新激活 previous 的 Compose 和镜像。持久数据不删除；自动产生回退前数据库备份。

V0.1 只有版本 1 初始化迁移。未来若有不兼容 schema，不能仅回退二进制；先明确迁移兼容性或进入受控恢复。恢复旧数据库后不得自动重发未确认请求。

## 异常退出后的 Gateway 锁

OOM 或强制结束后，旧容器的 PID namespace 可能留下无法从新容器自动核实的锁。先确认旧持有容器已经停止，再在当前容器运行 `node /app/openclaw.mjs gateway recover-lock --json`，检查记录，随后用该次返回的 fingerprint 执行 `gateway recover-lock --confirm FINGERPRINT --json`。

不能直接删除锁文件，也不能仅依据心跳变旧就回收。正常发布给 Gateway 90 秒停机时间；如果锁记录已变化，官方确认命令会拒绝旧指纹，需要重新检查。

## 基础验收

真实链路验证必须经过产品 API 和 OpenClaw，而非直接向 DeepSeek 发一条请求就宣布完成。验证文字流、多轮工具、跨新会话记忆、scope、更正、删除、任务等待、幂等和容器重建。

测试数据使用明确前缀并在验收后定向清理。清理只按本次生成的实体 ID 和关联记录执行，不清空用户数据。
