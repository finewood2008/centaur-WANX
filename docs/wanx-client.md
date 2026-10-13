# 万象电脑端

当前客户端位于 `wanx-client/`。盒子管理、连接、切换和蓝牙配网统一在该客户端中完成；Dashboard 提供盒端业务控制台，不再提供盒子管理或 `/boxes` 路由。旧 `wanx-desktop/` 和 `wanx-admin-desktop/` 已删除。

## 启动与打包

在仓库根目录执行：

```sh
npm ci --prefix wanx-client
npm test
npm start
npm run package:mac
# Windows 发布主机：npm run package:windows
```

上述入口分别转发到 wanx-client 的测试、启动和打包脚本。原有 `start:client`、`test:client`、`package:client:mac` 与 `package:client:windows` 入口仍可使用。

账号、网络、盒端免登录、应用市场和平台配置以 [wanx-client 使用说明](../wanx-client/README.md) 为准。生产部署要求见 [自动入网与免登录部署说明](wanx-auto-p2p-deployment.md)，应用发布见 [应用市场说明](wanx-application-market.md)。

## Dashboard 与 SDK 依赖

`make build-frontend` 将 Dashboard 构建到 `src/octop/dashboard/`；不再提供独立桌面构建模式。

顶层 `vendor/centaurai-wanx-0.1.0-wanx.1-585a760033fa.tgz` 仍是 Dashboard 的本地依赖。`dashboard/src/api/modules/applications.ts` 和 `dashboard/src/pages/Admin/Applications/project.ts` 使用其 `centaurai-wanx/browser` 导出，负责应用管理协议和工程生成，因此不能随旧桌面端删除。SHA-256：`585a760033fafc8838553b3b1945e8e3949b53fbdedbf3580a477d900462026b`。

适配层源码位于 `packages/wanx-client-adapter/`。wanx-client 的运行依赖位于自己的 `wanx-client/vendor/`。

### 重建 Dashboard SDK

需要 Node.js 22+、Go 1.24+、Python 3 和标准 SDK 私库读取权限。根目录 `npm run build` 会重建当前平台原生宿主、生成带摘要的 SDK 包、更新 Dashboard 的依赖和锁文件，并构建 Web 控制台；普通 Dashboard 构建直接使用已经提交的 SDK 包即可。

```sh
git clone --no-checkout --filter=blob:none --sparse https://codeup.aliyun.com/667637d76d5f7b05cc5d9ed7/nexusaos/nexusaos-centuarai-conn-sdks.git standard-sdk
git -C standard-sdk sparse-checkout set go release/go-connectivity-sdk-0.2.0
git -C standard-sdk checkout 6ff9bfa02f4df9df650a25e7378891d74dbd0b8b
npm install --prefix packages/wanx-client-adapter
npm ci --prefix dashboard
npm run build
npm test --prefix packages/wanx-client-adapter
```

该固定提交对应 Go SDK `0.2.0`、Core `0.1.1`，是私有适配层的来源基线，不是 wanx-client 内置 NetBird 引擎的版本。已提交包中的原生宿主为 macOS arm64；其他目标需分别构建和验收。第三方声明见 [适配层许可说明](../packages/wanx-client-adapter/THIRD_PARTY_NOTICES.md)。

### SDK 来源与兼容性约束

2026-10-08 的源码核对记录保存在 Git 提交 `daa4751` 中：当时标准 SDK 源码未修改，Go SDK `v0.2.0` 与 `p2p-core-go v0.1.1` 的 module ZIP 摘要与交付记录一致；该次核对未运行 SDK 测试或连接真实盒子。私有适配层不是标准 SDK 的正式发布。导入的 UI 基于 `7d84a9973a2e18b7083d4b21d68fe6332123765c`，包含当时已有的本地修改，不能据此视为纯净 Octop 上游快照。

以下限制适用于该固定 SDK 基线及其适配层，不代表当前 wanx-client 的 NetBird、Host SDK 或 bridge 采用相同协议与限制：

- 使用标准 SDK 的公开 HTTP、`OpenHTTPStream` 和 `OpenMessageStream` 接口，不修改内部身份或凭据函数以绕过兼容性问题。WebSocket 的 Bearer 请求头与服务端 query/首帧 token 认证必须逐版本核对，通过受支持的接口衔接。
- 该版普通请求整体上限为 2 MiB，Go 路线当时没有上传流；不能由接口名称推断流式能力，也不能套用知君产品的大文件合同。当前 Host 上传与流式能力以 [Host 应用接入](wanx-host-app-integration.md) 为准。
- 旧 Electron 通用包 `2.0.0` 声明 `stream:false`；知君 Electron 包使用 `zhijun-desktop / zhijun.workspace` 合同，不能直接替代万象通用客户端。
- 固定 Go SDK 的 `OmniaBinding` 使用 `omnia-desktop`、`desktop_native`、`omnia.use` / `remote.p2p`、`nexusaos.p2p-app.v2` 与 `SOVEREIGN_DIRECT_ONLY`。这些产品身份和网络策略不能与知君或当前 NetBird 合同混用。知君交接文档中的 Gateway/ICE 主机只是环境线索，不能直接当作万象批准的发行配置。
- 按固定提交配套的交付包、本地 module 安装器和摘要重建；当时交付文档声明远端 Go tag 未发布，不能假设 `go get` 能取得对应版本。源码核对、构建成功和模拟测试均不替代真实账号、设备、目标平台及发布验收。
- 平台设备访问权不自动授予盒端管理员权限；UI 管理能力仍须由对应盒端身份、权限及路由许可判定。

## 产品范围与模块边界

完整功能范围继续遵循 [CLIENT_SCOPE.md](../CLIENT_SCOPE.md)。Octop 原有服务端、CLI、Dashboard、Wails 桌面壳、发布流程和测试保留；不能因 WANX 客户端没有调用就删除。

- `wanx-client/` 管理平台账号、设备目录、发现、配网、认领、连接和应用生命周期。Electron 主进程以 `shell/entry.mjs` → `shell/main.mjs` 启动，加载 `local-ui/renderer/` 与 `local-ui/panel/`；renderer 只通过受限 preload 调用主进程。
- 网络使用现有 NetBird/P2P runtime，不创建第二套网络客户端或账号会话。产品连接路径不得失败后回退系统 TCP 或未经验证的直连。设备身份按完整稳定 ID 核验，地址、名称及名称后缀不能代替身份和授权。
- Dashboard 页面和资源由盒端提供。当前客户端经本机临时网关访问独立 `wanx-bridge`，应用通过 Host SDK 使用公开协议；旧规划中的“无代理、无应用网关、无应用商店”不再描述当前架构。现行协议见 [Host 应用接入](wanx-host-app-integration.md)。
- 平台账号、设备总表、蓝牙与配网逻辑不进入 Octop 领域层；bridge 通过公共 HTTP/OIDC 接口衔接。不得读取 Octop 私有数据库或复制其业务逻辑。新专家应用缺少公开接口时应明确记录能力缺口，不能把 UI 定制当作后端能力已具备。
- 原有 HTTP、WebSocket、SSE、Agent、工作区和业务权限保持边界。网络可达、平台登录、设备授权与 Octop 业务身份是不同验证步骤；平台密码不得下发盒子或复制平台用户表到 Octop。

## 身份、隔离与交付约束

- 平台私钥、刷新凭据和票据留在受保护的主进程/系统存储；Octop JWT 由 bridge 私有持有。长期 token 不放入 URL，不通过关闭证书校验、CORS 或浏览器安全机制解决接入问题。
- 盒子 ID、Octop 用户、应用和 Agent 实例分别建立上下文；专家模板 ID 不等于 Agent 实例 ID。切盒、退出、撤权和会话失效应关闭旧流与 WebSocket、取消请求并隔离迟到响应；已有应用不能静默转向新盒子。
- 用户的设备目录来自 Owner/Grant 授权，网络 peer 列表不能代替归属关系。撤权需要同时验证客户端入口、网络策略、bridge 会话及长连接失效，不能只隐藏按钮；未完成撤销应明确报告。
- 发现、配网、认领和初始化属于独立流程。重复提交、超时、取消与恢复必须可观察；具体协议以 [设备发现研究](research-zhijun-device-discovery.md) 及当前 SDK 为依据，不保留 demo adapter 作为生产路径，也不宣称所有目标平台已验证。
- 客户 Owner 的 Octop `admin` 身份不等于公司员工运维资格；独立运维授权链仍待实现，要求见 [公司运维与客户身份边界](wanx-admin-v1.md)。

## 验收要求

| 边界 | 必须验证的结果 |
| --- | --- |
| 账号与设备 | 登录/刷新/退出、设备目录和授权一致；发现身份、证书、网络可达与健康状态分开诊断。 |
| 首次接入 | 发现、受验证身份、Wi-Fi、认领、初始化、取消和恢复流程有对应 SDK/平台证据；不凭扫描名称猜设备。 |
| 传输与隔离 | HTTP、上传下载、SSE、WS 保持原协议，取消生效；盒子/用户/Agent 切换无旧响应串写。 |
| Dashboard 与应用 | 正确身份和权限打开盒端页面；应用在正确上下文调用公开 API 并展示流式结果，缺失能力明确报告。 |
| 撤权与部署 | 策略、短租约和会话失效联动；监听地址、证书、ACL、版本升级及公开接口兼容经过验证。 |
| 发行 | 合成测试、构建、真实账号盒子、公网直连/relay、Windows 运行、签名与公证分别记录，不能相互替代。 |

执行 `make all`、Dashboard TypeScript 检查及 `make build-frontend`；客户端执行 `npm test`，bridge 执行 `npm run test:bridge`。接口、设备与发布环境的验收依照当前部署文档，不沿用旧快照的测试数字作为完成证据。

旧客户端快照、阶段规格和迁移过程可从 Git 的 `daa4751`、`3ea65fa` 查看；有效边界已归并到本文，当前操作说明以本文、wanx-client README 和对应专题文档为准。
