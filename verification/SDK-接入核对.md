# 万象电脑客户端 · 标准 SDK 接入核对

本文件记录首次源码核对；随后已完成 macOS arm64 开发预览构建，见 [构建结果](构建结果.md)。

核对日期：2026-10-08。仓库：用户指定 Codeup SDK；当前 `master` 提交 `6ff9bfa02f4df9df650a25e7378891d74dbd0b8b`。

## 接入判断

万象是 WANX，也就是保留业务能力、定制 UI 的 Octop。仓库中最匹配这一产品的现有接入合同是 Go SDK 0.2.0 的 `omnia-desktop` 原生桌面合同。

SDK 已提供平台密码/SMS 登录、会话轮换、授权设备列表、签票、Direct P2P，以及 Octop 的统一身份、续租、退出和已有本地用户显式关联。可调用普通 HTTP、HTTP 响应流和 WebSocket 消息流。消费方需要写桌面宿主适配与 UI，并不需要重新实现这些通信协议。

Electron 通用包 2.0.0 当前只有 HTTP 请求能力，`stream:false`；不能因为导出了 `openStream` 就判定它能承载现有 WANX 流式页面。知君 WANX Electron 包属于 `zhijun-desktop / zhijun.workspace` 产品，采用知君目录与工作区合同，不能因为包名带 WANX 就用作万象通用客户端。

建议保留现有 WANX React 界面及 Electron 桌面壳，通信宿主使用标准 Go SDK 的公开方法，客户端自有适配层负责固定路由、生命周期和页面网关。

## SDK 中可确定的信息

| 项目 | 值 | SDK 来源 |
|---|---|---|
| Go SDK | 0.2.0 | `go/connectivity/types.go` |
| Core 依赖 | 0.1.1 | `go/go.mod` |
| 平台账号 Base URL | `https://boss.nexusaos.qitus.cn/prod-api` | `go/docs/octop-101-integration.zh-CN.md` |
| Gateway / ICE 文档主机 | `gateway.remote.qeeshu.com` | `docs/zhijun-product-integration-handoff.zh-CN.md`，该值来自知君交接文档，作为平台环境线索；万象发行仍需核实宿主批准配置 |
| 原生桌面应用身份 | `omnia-desktop` | `go/connectivity/types.go:OmniaBinding` |
| 平台标签 | `desktop_native` | 同上；平台账号注册标签另用 `macos/windows/linux` |
| 用途 / 范围 | `omnia.use` / `remote.p2p` | 同上 |
| 网络策略 | `SOVEREIGN_DIRECT_ONLY` | 同上；不能套用知君包的自动中继行为 |
| 协议 | `nexusaos.p2p-app.v2` | 同上 |

## 需处理的产品兼容项

1. SDK 托管身份的 WebSocket 通过 Bearer 请求头认证；检查过的旧 WANX 服务端路由只接受 query 或首帧 token。复用 UI 可行，但服务端需支持请求头认证，或者平台正式提供经过审查的兼容 API。不能修改标准 SDK 的内部凭据函数来实现产品接入。
2. 标准普通请求整体上限 2 MiB，Go 路线尚未提供上传流。知君产品的独立大文件上传合同不自动适用于万象。
3. UI 展示的所有管理能力仍由盒端权限和远端路由许可决定。平台设备访问权不自动授予盒端管理员身份。
4. 当前 Go 交付包提供本地 module 安装器及固定摘要；文档声明远端 Go tag 未发布，应使用匹配交付包，不能假定 `go get` 已可下载对应 tag。

## 本次检查范围

已读取实际 SDK 源码、公共方法、产品绑定及接入文档。标准源码内容与克隆提交一致，Go SDK/Core module ZIP 摘要与交付记录一致，记录见 `sdk-review.json`。

未运行 SDK 测试、未登录真实平台账号、未连接真实盒子，未验证生产主机或 Windows/macOS 发行。当前目录的客户端代码仅是预备草稿，尚未构建和验收，不作为完成客户端的交付。
