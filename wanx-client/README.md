# 万象连接：内置 P2P 网络

本目录按《万象项目结构与盒端接入设计》提供独立客户端。P2P 用户态引擎随万象一起分发，由万象管理启动、授权、连接和停止；用户不需要另行安装或启动独立网络客户端。默认管理地址为 `https://p2p.qeeshu.com`。

## 使用与开发

在 `centuarai-wanx/` 根目录运行：

```sh
# 纯 Web 开发：不需要 Go、内置引擎或系统网络客户端
npm --prefix dashboard ci
npm run dev:web

# 源码开发：Node >= 22，Go >= 1.26；macOS 还需 Xcode Command Line Tools
npm --prefix wanx-client ci
npm run start:client

# 客户端与原生引擎测试
npm run test:client
npm --prefix wanx-client run test:native
# 盒端 bridge 与原生 Octop 公共接口合同测试（根环境）
npm run test:bridge
```

源码启动首次自动构建当前平台的引擎，后续直接使用已有二进制；修改 Go 代码后显式运行 `npm --prefix wanx-client run build:network` 重建。打包后的客户端内含引擎，不需要用户安装 Go。

macOS 源码启动同时构建 Swift 盒子名称读取助手，按源码内容缓存；发布包内置该助手，用户无需 Swift 工具链。Windows x64 构建 WinRT 盒子发现助手，发布包也内置该助手。

Web 默认 `http://localhost:5173`，现有 Vite 将 `/api` 和 API WebSocket 转发到 `127.0.0.1:8088`。后端另行启动；使用 `VITE_API_PORT=18088 npm run dev:web` 可更换开发后端端口。此入口不导入或启动内置网络。

客户端首次默认开启 P2P，但未登录时不会启动网络引擎。用户主动关闭后会保存偏好，后续登录不会重新强制开启。

1. 使用万象账号密码登录。服务端校验账号与当前客户端身份后自动签发一次性入网凭据，客户端完成注册或恢复；不需要独立网络授权。
2. 登录后独立加载「我的盒子」，连接中或 P2P 关闭时也显示已关联盒子。开启 P2P 时，为本人盒子的当前客户端准备缺失权限并等待盒端确认；缺少节点映射、授权待同步及无权限分别提示。在列表选择可打开的盒子。地址和权限来自平台，不手工填写 P2P IP，也不展示网络候选节点。
3. 客户端取得盒端签名挑战，向平台申请短时访问票据，再通过 P2P 兑换盒端会话。连接成功后，可在管理窗口的“设置 → 管理与切换盒子”中点击“打开盒子控制台”，无需再输入盒端密码。
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
├── local-ui/           应用首页、菜单栏面板、账号与盒子设置
├── octop/              盒端会话兑换、健康检查与 HTTP/SSE/WebSocket 代理
├── tools/              引擎编译、首次源码启动检查
└── tests/              网络、生命周期、代理、授权及窗口回归
```

`local-ui/renderer/discovery-selection.js` 管理设备发现与选择，提供 `start / choose / reset / dispose`；通过回调交付展示快照、提示和选中的候选。扫描与重选在点击调用栈内同步触发蓝牙 chooser，12 秒扫描超时仍由现有 transport/picker 处理；非空结果保留 2 分钟，重选失败不续期，到期会取消仍在进行的重选。`reset` 清理选择并隔离迟到结果，`dispose` 额外解除 Discovery 订阅，不关闭共享 GATT transport。页面、Wi-Fi 表单及 `wanxSetup` 配网编排仍由 renderer 和现有主进程实现负责；返回设置只清理选择，显式取消才调用配网取消。

`createNetwork()` 提供 `snapshot / subscribe / setEnabled / refresh / resolveEndpoint / login / enroll / close`。默认 disabled，不启动子进程。内置引擎使用应用自己的配置目录、peer 私钥和随机网络端口，不读取或控制系统网络客户端 服务。

启用后每 1 秒通过本地 IPC 读取引擎状态，状态不变时不通知界面，关闭后停止轮询。这会将原来最多约 15 秒的状态显示滞后缩短到约 1 秒，不增加平台接口请求频率。该时间不包含切换 Wi-Fi/手机热点后的隧道重建、网络检测和重试耗时，不能视为跨网络连接的总恢复时间。源码修改后须重新启动客户端；已安装版本需要更新客户端包，单独更新盒子不会生效。

P2P 模式所有拨号都经内置引擎：包括 `/api/health`、普通请求、上传下载、SSE 和 WebSocket。JS 通过仅回环监听、随机令牌保护的 CONNECT 通道连接 Go 引擎；Go 核对目标当前 peer 后调用 `embed.DialContext`。失败不会回退系统 TCP。真实目标的 Host、Origin 和 HTTPS 证书校验保持不变，隧道令牌不发送给盒子或渲染页面。

Dashboard 按需在独立临时 Electron session 中打开，不随连接自动弹出；重复点击会聚焦已有窗口。盒子页面无 Node、preload 或控制 IPC。关闭 Dashboard 只清理其窗口和浏览器会话，不断开盒子或影响应用；切换、断开盒子、关闭网络及退出登录会关闭旧 Dashboard。Dashboard 继续来自盒子自身，原有业务页面与 API 不修改。

## 桌面图标与菜单

应用首页通过在线市场 API 查询候选、授权下载并验证签名安装包。应用包可复用万象运行时（`launchMode: "shared"`，默认），也可自带完整 Electron（`launchMode: "bundled"`，需声明系统/架构并接入 SDK 的 Electron 生命周期 helper）。同一应用只展示一个当前版本，安装更高 SemVer 版本后在下次打开时完成旧进程回收并切换；历史版本无法比较时先选择当前版本。停止和退出会等待应用主进程退出，超时强制终止，回收失败会明确报错。完整包的入口是包内可执行程序；`.dmg`、`.msi` 或安装向导 `.exe` 不能直接导入。本地 ZIP／目录安装保留为默认关闭的开发 IPC 入口，正常页面不展示。包结构与接入示例见 [WANX Host 应用接入](../docs/wanx-host-app-integration.md)。

Host 和共享运行时应用启动经过 `shell/entry.mjs`：普通启动进入 Host；市场 `--wanx-managed-app` 子进程先验签，开发包 `--wanx-application` 子进程校验本地记录，两者都只加载已安装清单指定的 JS 入口，在 Host 单实例锁和网络初始化之前分流。开发启动会额外传入万象源码目录，打包版直接复用可执行文件，不能依赖只适用于默认 Electron 启动器的 `--app` 参数。独立运行时应用直接启动包内可执行程序，通过 SDK helper 对接相同的启动协议。两种应用均使用独立 Chromium 数据目录，窗口完成首次页面加载后才向父进程报告启动成功；提前退出、加载失败或 30 秒未就绪会撤销该启动会话，并在首页提示重试。业务 API、Host SDK 的传输接口和 Web/LAN 模式不变。

发布前可设置 `WANX_PACKAGED_EXECUTABLE` 为打包程序的可执行文件路径，运行 `node --test tests/packaged-application-seam.test.mjs`。该 seam 使用临时用户目录，验证真实打包进程进入 manifest 入口，以及应用异常时返回失败，不会读取真实盒子或账号。

完整产品名称为“半人马AI-万象”，英文为“CentaurAI-WanX”。应用包及窗口内保留现有橙蓝半人马原图；窗口和快捷面板的 Logo 是“关于万象”按钮，打开系统关于弹窗，显示完整中英文名称。macOS 菜单栏使用原图轮廓的单色模板图标，保留透明背景，提供 22 像素及 44 像素 Retina 资源，由系统适配明暗外观；Windows 托盘保留彩色多尺寸图标。资源位于 `resources/`，macOS 执行 `npm run build:icons` 从 `local-ui/renderer/assets/centaurai-mark.png` 生成。品牌展示不改变已有包名、应用 ID、账号目录或加密存储身份。

macOS 的日常入口为菜单栏快捷面板（宽 400 像素、最高 560 像素）：左击开关，右击提供设置、关于和退出；点击外部或 Escape 收起。宿主不占 Dock，具体应用继续使用正常窗口和 Dock。面板优先显示我的应用，盒子一行仅显示当前名称和状态，底部进入应用商店。管理窗口约 860×640，顶部为“应用商店／设置”；低频的盒子管理和切换归入设置，登录和蓝牙配网仍只在这个持久窗口完成。关闭仅隐藏，保留输入和任务。Windows 保留窗口入口和托盘交互。

打开应用时，已连接盒子会直接启动或唤起原应用；没有连接时先选择并确认盒子。上次成功连接仅按账号和服务环境记录设备 ID，作为预选项，绝不代替授权或用户确认。配网完成仍需确认连接并打开。取消、退出登录或手动切盒后，迟到结果不能继续打开应用；切盒不会把已有应用静默转向新盒子。

主进程统一广播连接、已安装应用和按应用区分的操作状态。安装、更新、卸载、回退和版本选择完成后两窗同步；安装无需盒子连接，隐藏窗口继续执行。快捷面板使用独立 preload 和窄 IPC 白名单，不提供账号写入、市场变更、手动连接/断开/刷新盒子或蓝牙接口；未连接时仍可通过专门的请求、确认和取消接口完成“连接并打开应用”。配网仍校验管理窗口的 webContents、主 frame 和完整本地 URL。

macOS 扫描期间通过 CoreBluetooth、Windows x64 通过 WinRT 只读公开 Device Info，使用同一个外设的精确标识对接 SDK 候选。发现列表按完整 Registry ID 查询平台库存的设备名称，也可显示当前账号中的名称或盒端提供的非通用名称；名称不可得时明确显示“未获取到盒子名称”，不将库存编号、设备 ID 或蓝牙广播代码作为名称。设备编号和广播名仅作核对用的辅助信息，不按后缀或列表顺序猜测身份。Windows 扫描约 32 秒，单台 GATT 读取最多 25 秒、最多 3 台并发；macOS 单设备连接最多等待 5 秒，连接成功后独立给予服务发现与名称读取 3 秒，整次扫描仍受约 12 秒总时限约束。助手不写入配置，取消后断开；公开信息仅用于显示，选中后仍走原有受验证的配网身份流程。

公开身份允许展示尚未登记或配对窗口已关闭的盒子，但不能据此进入配网。界面和宿主在确认身份时检查登记状态及配对窗口，分别提示完成平台登记或重新开启配网模式；这些检查不会替代 SDK 的后续身份、协议和会话校验。配网错误使用单独文案，不再回退成应用市场错误。

身份验证后，配网页自动扫描盒子附近的 Wi-Fi，按信号强度提供选择，并按网络安全类型显示密码输入。刷新保留已选网络及输入；隐藏网络可手工添加。不支持的安全类型不会当作开放网络连接。扫描来自盒端无线网卡，经过现有 V2 加密蓝牙会话返回，结果仅存于内存，不写入日志或配网恢复记录。盒端在后台扫描，列表分页传输，避免超过蓝牙帧上限或阻塞配网；旧盒端不支持时会提示扫描失败，可更新盒端配网组件或使用手工输入。此功能需同时更新盒端 discovery 组件和客户端，客户端源码更新后需重新启动。

配网 SDK 的本地补丁允许公开 `display_name` 使用 1–64 个 UTF-16 单元的名称，拒绝控制字符和不完整代理字符；仍兼容旧的 `CentaurAI Box`。补丁通过 `node tools/patch-provisioning-display-name.mjs` 从校验过的 vendor 原包重建，输出独立版本并由锁文件固定。Device Info 的原始字节保持不变，继续参与握手哈希校验；设备身份、证书、字段集合、规范 JSON 和 512 字节上限保持原有约束。更新 SDK 后需重新启动客户端，单纯重新扫描不会替换主进程已加载的 SDK。

手动打开显示面板；“登录电脑时启动”默认不登记，只有打包 Mac 应用中用户主动开启时才写系统设置，并重新读取系统结果。由登录项启动时静默运行，开发预览不会登记登录项。设置中的“退出当前账号”结束账号会话并断开盒子，宿主继续运行；系统应用菜单或托盘右键菜单中的“退出万象”会先说明所承载的应用和盒子连接将关闭，再等待应用及网络清理，并保留加密账号会话供下次恢复。关闭面板或管理窗口保留底座运行。

`Cmd/Ctrl+1` 打开日常入口，`Cmd/Ctrl+,` 打开设置，`Cmd/Ctrl+Shift+D` 打开当前盒子的控制台。配网向导期间保留当前步骤。编辑、缩放、全屏和窗口操作使用系统菜单能力。

`npm start` 在 macOS 创建并缓存独立的 `release/dev/万象.app` 开发运行包，更新名称、图标后进行本地 ad-hoc 签名。源码仍直接从当前项目加载，Electron 依赖原包不会被修改。Dock 悬浮名称、菜单和安装包均显示“万象”；`package.name`、既有账号、安装目录及系统加密存储身份保持不变。直接运行 `electron .` 会绕过这一步。非 macOS 开发启动保持原有运行方式。

## 构建与分发

应用市场的包格式、版本比较、签名与后台发布流程见 [WANX 应用市场开发与发布](../docs/wanx-application-market.md)。

```sh
# 当前平台，或一次构建 macOS/Windows 两种架构
npm --prefix wanx-client run build:network
npm --prefix wanx-client run build:network:all
# macOS 名称读取助手，默认当前架构；可追加 darwin-arm64 darwin-x64
npm --prefix wanx-client run build:discovery

# 打包；发布签名/公证使用相应平台的发布环境和证书
npm --prefix wanx-client run package:mac
npm --prefix wanx-client run package:windows
```

引擎输出到忽略版本控制的 `native/bin/`；electron-builder 按目标平台/架构把对应引擎复制到应用的 `resources/network/`。构建同时收集模块版本与许可证文件。没有发布签名证书时，本机验证产物不等同于已签名、公证的正式安装包。

网络引擎依赖基线为 `0.80.0`、Electron `37.10.3`；具体第三方模块与许可证随构建产物保留。WANX 基线 `6563103` / Octop `1.0.2b4`。不会读取 Octop 数据库、导入 Python 私有模块，或依赖即将退役的 `nexusaos-app`。旧 `wanx-desktop/`、`wanx-admin-desktop/` 已删除；Dashboard 作为盒端控制台保留，盒子管理统一在本客户端完成。

## 验证边界

客户端测试覆盖账号签名和加密存储、自动入网恢复、目录授权、盒端会话兑换、取消与切换竞态、硬租约截止、HTTP/SSE/WS 代理及 UI/IPC 边界。平台和独立 bridge 另有真实签名、重放、权限版本、过期与长连接续租集成测试。`npm run test:bridge` 使用仓库根环境验证真实 Octop 公共接口，不代表 bridge 发布包依赖 Octop。执行记录见 [设计方案验收记录](../docs/wanx-account-auto-p2p-plan.md)，旧版内嵌认证的测试数字不能替代本轮 bridge 验收。

本地测试使用隔离账号、模拟管理服务和本地盒端服务；尚需按部署文档使用实际账号和盒子验证跨公网直连/relay、绑定关系、策略撤销及完整登录流程。Windows 安装包运行、正式签名和公证另需发布环境验证。

### 启动耗时诊断

客户端默认将诊断写入 Electron `userData/logs/connection-timings.jsonl`；macOS 源码运行通常位于 `~/Library/Application Support/centuarai-wanx-client/logs/`。文件达到 512 KiB 后轮换为 `.previous`，只保留当前与上一份日志。`WANX_CONNECTION_TIMINGS=1 npm --prefix wanx-client start`（仓库根目录）额外开启控制台输出。

日志包含步骤、完成/失败状态、耗时，以及白名单内的错误码和 HTTP 错误状态码。`network.state` / `platform.state` 仅在状态变化时记录阶段和原因，可区分引擎退出、超时、授权拒绝与租约到期，并观察后续恢复；未知错误统一记为 `UNKNOWN_ERROR`。不写入请求地址、参数、账号、设备标识、令牌、响应正文或错误消息/堆栈。`client.initialize` 包括账号恢复、权限准备、平台会话恢复及引擎启动，不代表点击盒子后的业务页面加载耗时。

临时入网、续期或引擎故障会自动重试，等待间隔从 5 秒逐步增加，最长 60 秒，成功后复位。手动关闭、退出登录、客户端关闭、授权拒绝和硬租约到期会停止对应重试；重新建立连接必须重新取得有效平台授权。修改客户端源码后需重启万象生效。
