# 手机连接与无域名 HTTPS

Android 0.3+ 的“服务器连接”使用服务器根地址和独立设备凭据 JSON，不使用用户名密码、模型服务 Key 或 Mac Gateway 配对。每台手机应签发自己的逻辑设备身份；凭据签发不代表物理手机已完成可信配对。

## 两个输入框

- **服务器地址**：部署者提供的 `https://服务器域名`，或配置了可信 IP 证书的 `https://固定公网IPv4`。
- **设备凭据 JSON**：主人管理页签发的一次性响应，原样导入。包含 `device_id`、`credential_id` 和 `token`；可带 `server` 字段。实际令牌保存在私密文件，不写进 README、仓库或公开下载地址。

点击“验证并连接”后，App 会核对协议和设备 ID，通过 Android Keystore 加密保存令牌。以后重新打开 App 会读取本机配置。二维码若用于传递 JSON，是通过系统扫码工具复制文本再粘贴；当前 App 没有扫码自动登录入口。

## 独立 HTTPS 组件

没有域名时可使用 Let's Encrypt 的 IP 证书。IP 证书使用 `shortlived` profile，有效期160小时；由常驻 Caddy 自动续期。此方案需要固定公网IPv4，以及可从公网访问的 TCP443。证书协议说明见 [Let's Encrypt 官方说明](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)。

`deploy/https/` 固定 Caddy 官方版本和 SHA-256。独立 systemd 单元 `anylink-agent-https.service` 使用 DynamicUser、有限权限和独立证书存储，不修改现有 Nginx、80端口或 AnyLink Compose。首次部署遇到443被占用会停止，不接管其他服务。

```bash
# 在工程根目录，先下载 runtime-lock.json 对应的官方归档。
gh release download v2.11.9 --repo caddyserver/caddy \
  --pattern caddy_2.11.9_linux_amd64.tar.gz \
  --pattern caddy_2.11.9_checksums.txt --dir data/https
node scripts/deploy-https.mjs --host YOUR_SSH_ALIAS --ip YOUR_PUBLIC_IPV4
```

部署脚本核对归档SHA-256，提取官方二进制并保留LICENSE，验证Caddyfile和systemd单元，然后仅启用自己的服务。现有 AnyLink 应用继续监听 `127.0.0.1:3180`。

公网仅转发 `/edge/v1/*`、`/model/v1/*` 和进程健康检查；设备API仍需有效的设备令牌。主人管理接口 `/v1/*` 不通过该组件公开，仍使用SSH隧道。流式模型响应立即转发，不经过Mac。

文件位置：

- `/opt/anylink-agent-https/`：固定二进制、配置、归档校验及配置备份。
- `/etc/systemd/system/anylink-agent-https.service`：本项目独立单元。
- `/var/lib/anylink-agent-https/`：systemd管理的私有证书／ACME状态，更新或重启时保留。

检查和停止仅针对这个组件：

```bash
systemctl status anylink-agent-https.service
journalctl -u anylink-agent-https.service --since '10 minutes ago'
# 需要撤回公网入口时：
systemctl disable --now anylink-agent-https.service
```

停止HTTPS组件不删除证书、数据库、云端记忆或其他业务；原来的SSH访问仍可使用。公网IP变更后需要重新部署并更新手机地址。不要清空证书状态来代替正常续期。

## 手机首次验证

部署者先从外部网络使用系统默认信任验证证书，检查未授权请求被拒绝，再用手机自己的令牌验证身份、记忆与模型流。然后把地址和私密凭据交给手机用户。不能把开发预览身份、电脑上的JVM联调或电脑截图称为已完成真机验收。
