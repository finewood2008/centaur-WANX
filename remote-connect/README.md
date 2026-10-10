# WANX / 知君远程连接测试版

版本：知君桌面 0.3.0；Headscale 0.29.4；Tailscale/tsnet 1.104.1。

## 当前交付状态

- 已实现内置网络进程、知君远程配对入口、WANX 远程管理面板、Mac 常驻服务、一次性配对码、设备列表与撤销。
- 已用真实的本地 Headscale + DERP + tsnet 验证注册、固定证书 HTTPS 访问、服务重启、强制中继及设备撤销。另有管理 API 到客户端配对组件的集成测试。
- 尚无公网服务器和域名。因此正式远程服务未配置、未开放；没有完成跨互联网 / Windows 实机外网验收。
- 现有局域网访问保持可用。未配对时不启动客户端远程连接进程。

## 模块

`cmd/wanx-link`：Go 用户态网络进程。服务端只转发到 127.0.0.1:28733；客户端只连接 100.64.0.0/10 或 Tailscale ULA 的 28733 端口。TLS 由现有知君网关和桌面证书固定校验保持端到端验证。

`manager`：只监听 Mac loopback 的管理服务；每次启动随机本机访问令牌。Headscale 管理密钥只存 Mac 服务端 0600 配置文件，不进入安装包或知君网页。第一次配置检查专用网络只有 client → server:28733 的访问规则。

`ui`：WANX 菜单“远程访问”；可通过 `--remote-access` 单独打开。不改变现有 SDK 盒子连接路径或其 Direct-only 约束。

`zhijun-lan-test/desktop/shell/remote.cjs`：从一次性码注册专用节点；启动参数不带密钥；配对设置使用桌面安全存储。节点状态存用户目录，重启保留身份；新配对使用新状态目录。

## 运行 Mac 服务

```sh
/usr/bin/python3 remote-connect/tools/install-mac.py
```

服务安装到 `~/Library/Application Support/ZhijunServer/remote-connect`，配置在同级 `remote/headscale.json`，由 `ai.centaur.zhijun.remote` 登录启动项管理。关闭 WANX 管理窗口不会停止它。当前为登录 Mac 后启动；还未升级为免登录系统服务。

## 配置公网协调服务

1. 准备专用 Linux 公网服务器、域名 A 记录和证书通知邮箱。
2. 云防火墙允许入站 TCP 80/443、UDP 3478；SSH 保留原访问限制。无需开放 28733、50443、9090 到公网。
3. 把 `deploy/` 复制到服务器，执行：

```sh
sudo bash install-linux.sh connect.your-domain.com your-email@your-domain.com YOUR_PUBLIC_IPV4
```

脚本下载并校验固定版本 Headscale，使用内置 ACME 和 DERP，创建专用服务账号及 systemd 服务。**Linux 安装脚本尚未在真实公网服务器上执行验收。** 使用前确保 80、443、3478 未被其他服务占用；DNS 已指向该机。它不会覆盖已有 WANX Headscale 配置。

4. 安全取得 `/root/wanx-remote-setup.json`，在 Mac 的 WANX → 远程访问 → 管理员接入配置中导入，然后开启远程访问。此文件是管理员凭据，不发给知君用户，不提交仓库。
5. 生成配对码，在 Windows 知君菜单 → 连接服务器 → 在外也能连接中粘贴。配对码 15 分钟有效、只注册一台设备；不能授权访问全部内网。知君账号仍需正常登录并开通私人实例。
6. 手机热点连接笔记本，再验证对话、记忆、文件上传、服务器重启和撤销设备。

本版适合一台家庭服务器/一个专用网络。每台家庭服务器使用独立协调实例或经审计的独立策略；未实现面向大量客户的集中租户管理。不提供万能预授权密钥。管理员 API 密钥 90 天过期，需要在 Mac 服务配置中轮换；不要把密钥写进安装包。

## 已授权设备的撤销

管理面板仅显示、撤销本机 client 分组中的节点。撤销后重启网络转发进程，主动断开已有流；其他获准客户端会自动恢复。撤销不删除对话或记忆。取消本机配对只移除本机连接设置；若设备丢失，应在服务端撤销设备。

## 构建和测试

```sh
cd remote-connect
../.tooling/go/bin/go test ./...
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 ../.tooling/go/bin/go build -trimpath -ldflags='-s -w' -o bin/wanx-link-win32-amd64.exe ./cmd/wanx-link
node --test tests/*.test.mjs
cd ..
npm --prefix zhijun-lan-test/desktop test
npm --prefix zhijun-lan-test/desktop run package:win
```

本地组网测试状态保存在 `~/Library/Caches/ZhijunRemoteTests`，与真实 Headscale 服务及知君用户数据隔离。测试协调服务只监听 loopback，使用临时测试证书；该证书只传入测试子进程信任，不修改系统信任库。运行方式见 `tools/local-headscale.py`、`tools/integration.mjs`、`tools/manager-integration.mjs`。
