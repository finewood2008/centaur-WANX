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
3. 客户端取得盒端签名挑战，向平台申请短时访问票据，再通过 P2P 兑换盒端会话。连接成功后，可在应用首页的“当前盒子”区域或右上角“设置”中的“当前盒子”点击“打开 Dashboard”，无需再输入盒端密码。
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

Dashboard 按需在独立临时 Electron session 中打开，不随连接自动弹出；重复点击会聚焦已有窗口。盒子页面无 Node、preload 或控制 IPC。关闭 Dashboard 只清理其窗口和浏览器会话，不断开盒子或影响应用；切换、断开盒子、关闭网络及退出登录会关闭旧 Dashboard。Dashboard 继续来自盒子自身，原有业务页面与 API 不修改。

## 桌面图标与菜单

应用首页通过在线市场 API 查询候选、授权下载并验证签名安装包。应用包可复用万象运行时（`launchMode: "shared"`，默认），也可自带完整 Electron（`launchMode: "bundled"`，需声明系统/架构并接入 SDK 的 Electron 生命周期 helper）。同一应用只展示一个当前版本，安装更高 SemVer 版本后在下次打开时完成旧进程回收并切换；历史版本无法比较时先选择当前版本。停止和退出会等待应用主进程退出，超时强制终止，回收失败会明确报错。完整包的入口是包内可执行程序；`.dmg`、`.msi` 或安装向导 `.exe` 不能直接导入。本地 ZIP／目录安装保留为默认关闭的开发 IPC 入口，正常页面不展示。包结构与接入示例见 [WANX Host 应用接入](../docs/wanx-host-app-integration.md)。

Host 和共享运行时应用启动经过 `shell/entry.mjs`：普通启动进入 Host；市场 `--wanx-managed-app` 子进程先验签，开发包 `--wanx-application` 子进程校验本地记录，两者都只加载已安装清单指定的 JS 入口，在 Host 单实例锁和网络初始化之前分流。开发启动会额外传入万象源码目录，打包版直接复用可执行文件，不能依赖只适用于默认 Electron 启动器的 `--app` 参数。独立运行时应用直接启动包内可执行程序，通过 SDK helper 对接相同的启动协议。两种应用均使用独立 Chromium 数据目录，窗口完成首次页面加载后才向父进程报告启动成功；提前退出、加载失败或 30 秒未就绪会撤销该启动会话，并在首页提示重试。业务 API、Host SDK 的传输接口和 Web/LAN 模式不变。

发布前可设置 `WANX_PACKAGED_EXECUTABLE` 为打包程序的可执行文件路径，运行 `node --test tests/packaged-application-seam.test.mjs`。该 seam 使用临时用户目录，验证真实打包进程进入 manifest 入口，以及应用异常时返回失败，不会读取真实盒子或账号。

Dock、任务栏和应用包使用“万”字图标，与知君采用相同的朱红底、米白边框和宋体字标风格。macOS 菜单栏使用单色“万”字 Template 图标，并提供 Retina 版本；Windows 托盘使用多尺寸彩色图标。图标资源位于 `resources/`，可在 macOS 执行 `npm run build:icons` 从字体轮廓重新生成，产物随源码提交供各平台打包。

原生菜单与托盘提供主窗口、我的应用、设置、Dashboard 和退出入口。`Cmd/Ctrl+1` 返回应用首页，`Cmd/Ctrl+,` 打开设置，`Cmd/Ctrl+Shift+D` 打开当前盒子的 Dashboard。配网向导期间保留当前步骤。编辑、缩放、全屏和窗口操作使用系统菜单能力。

关闭主窗口会收起到菜单栏／托盘，保留盒子连接和已启动应用；点击 Dock 或托盘的“显示主窗口”可恢复。选择“退出万象”才关闭 Host、应用通道和网络引擎。Dashboard 入口只在登录、网络和盒子连接均就绪时启用，点击时仍会检查最新状态。

`npm start` 在 macOS 创建并缓存独立的 `release/dev/万象.app` 开发运行包，更新名称、图标后进行本地 ad-hoc 签名。源码仍直接从当前项目加载，Electron 依赖原包不会被修改。Dock 悬浮名称、菜单和安装包均显示“万象”；`package.name`、既有账号、安装目录及系统加密存储身份保持不变。直接运行 `electron .` 会绕过这一步。非 macOS 开发启动保持原有运行方式。

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
