# 内置 NetBird 引擎

该 Go sidecar 链接 NetBird `v0.80.0` 的公开 `client/embed`，使用用户态 WireGuard/netstack。它不依赖系统 NetBird 服务，不创建系统 VPN 接口，不修改默认路由，不接收其他节点的入站连接。

构建入口：`./cmd/wanx-netbird`。使用 Go 1.26 或更新版本；主工程的网络构建脚本负责各平台产物。保留 `go.mod` 中来自上游的依赖替换，尤其是 WireGuard 和 ICE。

```sh
go test -race ./cmd/wanx-netbird
go build -trimpath -o wanx-netbird ./cmd/wanx-netbird
```

## 主进程协议

stdin/stdout 为私有 NDJSON，每行一个 `{id, method, params}`；响应为 `{id, result}` 或 `{id, error: {code}}`。日志被丢弃，不向 stdout 或 stderr 写入凭据。只由桌面主进程调用，不向 Dashboard 暴露此接口。

- `start`：`{managementURL, configDir, deviceName, setupKey?}`，成功返回 `{proxy: {port, token}, status}`。同配置重复调用复用正在运行的 peer。首次注册无凭据返回 `auth_required`。
- `status`：返回 `{phase, reason, peers: [{ip, name, connected}]}`。启动后应持续轮询；管理或信令短暂断线返回 `error`，恢复后回到 `ready`。
- `login_begin`：使用与 `start` 相同的基础参数，通过管理服务的公开加密 gRPC API获取设备授权配置，返回 `{verificationURL, userCode, expiresIn}`。部署没有 device flow 时返回 `auth_unsupported`，可以使用一次性 Setup Key。
- `login_wait`：执行 RFC 8628 轮询，成功只返回 `{authenticated: true}`。JWT 只在 sidecar 内存中保留，下一次 `start` 消费它；不保存 Refresh Token，不通过 IPC 返回令牌。
- `stop`：取消授权、启动和活动连接，清空内存令牌，关闭代理及全部隧道。stdin EOF、SIGTERM 同样清理并退出。

管理服务必须使用 HTTPS；用户归组和访问策略由既有管理服务决定，本进程不调用管理 REST API修改用户、组或 ACL。持久化配置仅位于 Wanx 自有目录，目录权限 `0700`、文件 `0600`（Windows 由用户配置目录的 ACL保护）。设备私钥用于后续恢复身份，Setup Key 不写入本进程的业务配置。

## 应用流量

启动后只监听 `127.0.0.1` 的随机 TCP端口，要求 `Authorization: Bearer <随机令牌>`。代理仅接受 HTTP CONNECT，目标必须是当前 NetBird可见的活动 peer IP 和合法端口，拒绝任意域名、未知 IP；所有拨号均使用 `embed.DialContext`，没有系统网络回退。客户端在隧道内使用原始 HTTP/HTTPS 和 WebSocket，HTTPS仍由主进程验证盒端证书。

上游 `embed.Start` 的部分认证阶段尚不遵守传入 context。桌面主进程必须在超时/关闭时等待该子进程退出，必要时强制终止，然后才启动替代进程。应用退出关闭自己的 peer，不停止系统中其他应用的网络服务。

测试使用注入引擎、本机回环隧道和临时配置，不注册真实 peer、不需要 Setup Key。真实管理服务的 SSO、用户组传播与跨网络盒子访问仍需要部署联调。
