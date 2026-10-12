# 万象连接：内置 P2P 网络

本目录按《万象项目结构与盒端接入设计》提供独立客户端。P2P 用户态引擎随万象一起分发，由万象管理启动、授权、连接和停止；用户不需要另行安装或启动独立网络客户端。默认管理地址为 `https://p2p.qeeshu.com`。

## 使用与开发

在 `centuarai-wanx/` 根目录运行：

```sh
# 纯 Web 开发：不需要 Go、内置引擎或系统网络客户端
npm --prefix dashboard ci
npm run dev:web

# 源码开发：Node >= 22，Go >= 1.26（只用于构建内置引擎）
npm --prefix wanx-client ci
npm run start:client

# 客户端与原生引擎测试
npm run test:client
npm --prefix wanx-client run test:native
# 盒端 bridge 与原生 Octop 公共接口合同测试（根环境）
npm run test:bridge
```

源码启动首次自动构建当前平台的引擎，后续直接使用已有二进制；修改 Go 代码后显式运行 `npm --prefix wanx-client run build:network` 重建。打包后的客户端内含引擎，不需要用户安装 Go。

Web 默认 `http://localhost:5173`，现有 Vite 将 `/api` 和 API WebSocket 转发到 `127.0.0.1:8088`。后端另行启动；使用 `VITE_API_PORT=18088 npm run dev:web` 可更换开发后端端口。此入口不导入或启动内置网络。

客户端首次默认开启 P2P，但未登录时不会启动网络引擎。用户主动关闭后会保存偏好，后续登录不会重新强制开启。

1. 使用万象账号密码或短信验证码登录。服务端校验账号与当前客户端身份后自动签发一次性入网凭据，客户端完成注册或恢复；不需要独立网络授权。
2. 登录后独立加载「我的盒子」，连接中或 P2P 关闭时也显示已关联盒子。开启 P2P 时，为本人盒子的当前客户端准备缺失权限并等待盒端确认；缺少节点映射、授权待同步及无权限分别提示。在列表选择可打开的盒子。地址和权限来自平台，不手工填写 P2P IP，也不展示网络候选节点。
3. 客户端取得盒端签名挑战，向平台申请短时访问票据，再通过 P2P 兑换盒端会话，直接打开原有万象 Dashboard，无需再输入盒端密码。
4. 关闭 P2P 会取消等待、关闭 P2P 连接并停止引擎；「本机 / 开发连接」中的本机或 HTTPS 直连不受影响。纯 Web 开发继续使用 `npm run dev:web`。
5. 退出万象账号会关闭当前盒子会话并申请撤销网络授权；退出应用保留加密账号会话，便于下次恢复。应用只允许一个实例使用同一网络身份。

万象账号服务默认 `https://boss.nexusaos.qitus.cn/prod-api`，部署时可通过 `WANX_CONSUMER_URL` 指定 HTTPS 服务地址。网络管理地址默认 `https://p2p.qeeshu.com`。管理 API 凭据只配置在服务端，不能分发给客户端。

## 账号、设备与权限

平台复用现有 Consumer 账号、AppClient、Owner/Grant 和成员授权。新网络控制面校验这些事实，登记当前客户端 peer，并维护该客户端到已授权盒子 TCP 8088 的精确策略。不会把所有账号加入同一共享访问组，网络节点列表也不代表盒子归属。

账号私钥和刷新凭据使用操作系统加密存储；账号切换隔离网络身份。入网码、平台票据和 bridge 短期会话留在主进程，Dashboard 仅取得当前临时网关的随机会话标识。原生 Octop JWT 由盒端 bridge 私有持有。盒端签名挑战一次性消费，短租约续签持续核验权限。正常续签保留 SSE/WS，授权到期或变更后关闭旧会话；原生 Octop JWT 到期时仍按原有行为重连。

盒端功能位于独立 [`wanx-bridge/`](../wanx-bridge/README.md)，通过 Octop 公共 HTTP/OIDC 接口建立业务身份。本功能不需要修改 `src/octop`。公开 P2P 端口由 bridge 接管，原始服务与内部 OIDC 仅监听 loopback；不能把旧的原始业务端口继续对外公开。

**源码接入不代表生产环境已部署。** 启用前需要平台数据库迁移、网络服务配置、可信盒子 peer 登记、盒端签名公钥登记及 SSO 密钥配置，参见 [自动入网与盒端免登录部署验收](../docs/wanx-auto-p2p-deployment.md)。缺少这些配置时会明确失败，不退回要求普通用户登录网络后台。

## 结构与传输边界

```text
wanx-client/
├── platform.mjs        账号登录、自动入网、授权目录与续租编排
├── account/            Consumer 签名请求、账号身份与系统加密存储
├── client.mjs          连接生命周期、取消、盒子切换
├── network/            内置进程管理、NDJSON 控制、专用 CONNECT Agent
├── native/             Go P2P 用户态引擎、设备授权、受限隧道服务
├── shell/              Electron、受限 IPC、独立临时浏览器会话
├── fleet/              万象账号、P2P 开关、我的盒子和开发连接
├── octop/              盒端会话兑换、健康检查与 HTTP/SSE/WebSocket 代理
├── tools/              引擎编译、首次源码启动检查
└── tests/              网络、生命周期、代理、授权及窗口回归
```

`createNetwork()` 提供 `snapshot / subscribe / setEnabled / refresh / resolveEndpoint / login / enroll / close`。默认 disabled，不启动子进程。内置引擎使用应用自己的配置目录、peer 私钥和随机网络端口，不读取或控制系统网络客户端 服务。

启用后每 1 秒通过本地 IPC 读取引擎状态，状态不变时不通知界面，关闭后停止轮询。这会将原来最多约 15 秒的状态显示滞后缩短到约 1 秒，不增加平台接口请求频率。该时间不包含切换 Wi-Fi/手机热点后的隧道重建、网络检测和重试耗时，不能视为跨网络连接的总恢复时间。源码修改后须重新启动客户端；已安装版本需要更新客户端包，单独更新盒子不会生效。

P2P 模式所有拨号都经内置引擎：包括 `/api/health`、普通请求、上传下载、SSE 和 WebSocket。JS 通过仅回环监听、随机令牌保护的 CONNECT 通道连接 Go 引擎；Go 核对目标当前 peer 后调用 `embed.DialContext`。失败不会回退系统 TCP。真实目标的 Host、Origin 和 HTTPS 证书校验保持不变，隧道令牌不发送给盒子或渲染页面。

每次盒子连接使用独立临时 Electron session。盒子页面无 Node、preload 或控制 IPC；关闭/切换清理窗口和会话。Dashboard 继续来自盒子自身，原有业务页面与 API 不修改。

## 构建与分发

应用市场的包格式、版本比较、签名与后台发布流程见 [WANX 应用市场开发与发布](../docs/wanx-application-market.md)。

```sh
# 当前平台，或一次构建 macOS/Windows 两种架构
npm --prefix wanx-client run build:network
npm --prefix wanx-client run build:network:all

# 打包；发布签名/公证使用相应平台的发布环境和证书
npm --prefix wanx-client run package:mac
npm --prefix wanx-client run package:windows
```

引擎输出到忽略版本控制的 `native/bin/`；electron-builder 按目标平台/架构把对应引擎复制到应用的 `resources/network/`。构建同时收集模块版本与许可证文件。没有发布签名证书时，本机验证产物不等同于已签名、公证的正式安装包。

网络引擎依赖基线为 `0.80.0`、Electron `37.10.3`；具体第三方模块与许可证随构建产物保留。WANX 基线 `6563103` / Octop `1.0.2b4`。不会读取 Octop 数据库、导入 Python 私有模块，或依赖即将退役的 `nexusaos-app`。旧 `wanx-desktop/`、`wanx-admin-desktop/` 和共享 Dashboard 保留原实现。

## 验证边界

客户端测试覆盖账号签名和加密存储、自动入网恢复、目录授权、盒端会话兑换、取消与切换竞态、硬租约截止、HTTP/SSE/WS 代理及 UI/IPC 边界。平台和独立 bridge 另有真实签名、重放、权限版本、过期与长连接续租集成测试。`npm run test:bridge` 使用仓库根环境验证真实 Octop 公共接口，不代表 bridge 发布包依赖 Octop。执行记录见 [设计方案验收记录](../docs/wanx-account-auto-p2p-plan.md)，旧版内嵌认证的测试数字不能替代本轮 bridge 验收。

本地测试使用隔离账号、模拟管理服务和本地盒端服务；尚需按部署文档使用实际账号和盒子验证跨公网直连/relay、绑定关系、策略撤销及完整登录流程。Windows 安装包运行、正式签名和公证另需发布环境验证。

### 启动耗时诊断

源码运行时可使用 `WANX_CONNECTION_TIMINGS=1 npm --prefix wanx-client start`（仓库根目录）记录入网各步骤耗时。日志只包含固定步骤名、完成/失败状态和毫秒数，不包含请求参数、令牌、设备标识或响应内容；默认关闭。`client.initialize` 包括账号恢复、权限准备、平台会话恢复及引擎启动，不代表点击盒子后的业务页面加载耗时。
