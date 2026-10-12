# 半人马AI-万象 · CentaurAI-WANX

WANX 服务端运行在盒子中，负责账号、配置、Agent、记忆和用户数据。**万象电脑端**在笔记本上运行独立的客户端界面，通过 `centaurai-wanx` SDK 联入盒子。知君及其他产品使用同一个通用 SDK，并拥有各自的应用身份和用户实例。

当前万象底座与应用市场代码位于 `wanx-client/`，通过 Consumer 账号查询已上架应用、检查版本和下载安装 `.wanxapp`，连接盒子后启动应用。在仓库根目录运行 `npm run start:client`；macOS 和 Windows 打包分别使用 `npm run package:client:mac`、`npm run package:client:windows`。macOS 此命令输出应用目录。详细使用见 [客户端说明](wanx-client/README.md) 和 [应用市场说明](docs/wanx-application-market.md)。

下文的 `wanx-desktop/` 是保留的 Dashboard 桌面壳实现，根目录 `npm start`、`npm run package:mac`、`npm run package:windows` 仍对应它，不包含新的 WANX 应用市场。Web 控制台的盒子管理与该桌面壳继续保留，管理员权限由选中的盒子决定。

## 本次 GitHub 迁移

本仓库已从旧 DSH 版切换为 Octop 定制版 WANX。旧版提交记录保留，迁移前版本位于 `backup/dsh-before-octop-20261009`。源工程基础提交为 `7d84a99`，同时包含本地现有的 WANX 平台扩展与盒子管理源码。仓库保持私有，包含构建所需的私有 SDK 依赖，不包含本机账号、会话、数据库、日志或安装包。

「盒子管理」已接入 SDK 的平台账号、设备目录、OTA、转移、支持会话及登录设备管理；具体能力和限制见 [SDK 盒子管理说明](sdk-box-management/README.md)。依据 SDK 的 bootstrap 就绪状态、Direct 连接、统一身份及 V2 清除流程重新设计的方案尚未全部实现，不代表真实盒子已经完成联调。

## 当前客户端

- **盒子连接**：平台账号登录 → SDK 授权设备目录 → 选择盒子 UUID → 签票与 P2P Direct → WANX 统一身份。提供已有 HTTPS 服务的兼容接入。切盒释放旧会话和数据流，重新核验权限。
- **原有配置**：继续使用模型、存储、连接器、技能、插件、安全、账号、审计和远程桌面页面，按服务端权限显示。
- **应用中心**：注册产品定义、Agent 模板和所需资源；配置盒子部署与启停；登记安装包版本和推荐版本；开通用户访问；导入、导出清单及生成 SDK 工程。
- **用户隔离**：管理接口仅返回产品与授权元数据。私人实例继续由 WANX 原生模块管理，产品停用不删除用户资料，模板更新不覆盖已有实例。

电脑端启动后显示自己的工作台和盒子连接页，不加载盒子的网页，也不在电脑上启动 WANX 服务端。浏览器直接打开盒子的 HTTPS 地址仍属于服务端 Web 控制台；纯浏览器不具备 SDK 原生 P2P Host 能力。

完整流程、SDK 安装包及 SHA-256 见 [WANX 客户端说明](docs/wanx-client.md)，架构与合同见 [V1 设计](docs/wanx-admin-v1.md)。

## 构建

```sh
uv sync --frozen
npm ci --prefix dashboard
npm ci --prefix sdk-box-management
npm run build --prefix sdk-box-management
make all
npm run build --prefix dashboard
# 本地 Web 控制台
uv run octop run --host 127.0.0.1 --port 8088
```

独立电脑端：

```sh
npm ci --prefix sdk-box-management
npm run build --prefix sdk-box-management
cd dashboard && npm ci
cd ../wanx-desktop
npm ci
npm run build
npm test
npm start
# 安装包：npm run package:mac / npm run package:windows
```

盒子后端保留现有 Python 包名与 CLI，使用 `uv run octop run` 启动。`make build-frontend` 构建服务端 Web 控制台；`wanx-desktop` 的构建生成独立电脑端资源。当前客户端 SDK 适配层源码位于 `packages/wanx-client-adapter/`，Dashboard 和 Electron 共用 `vendor/centaurai-wanx-0.1.0-wanx.1-585a760033fa.tgz`；`dashboard/vendor/` 保留旧版依赖供历史参考。发行方必须配置批准的 Consumer、Gateway、ICE 主机，见 [电脑端说明](docs/wanx-client.md)。

## 独立客户端源码与远程连接

已整合 `codex/wanx-local-20261010` 的桌面客户端快照，同时保留本仓库的 Python 服务端、Web 盒子管理和两种 Dashboard 构建模式。普通构建输出到 `src/octop/dashboard/`，`build:desktop` 输出到 `wanx-desktop/dist-ui/`。

客户端范围和当前差距见 [CLIENT_SCOPE.md](CLIENT_SCOPE.md) 与 [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)。使用已提交的 vendor 包时可直接执行上面的独立电脑端构建命令。需要从适配层源码重建原生宿主时，先按 [快照恢复说明](SNAPSHOT.md) 检出固定版本的 `standard-sdk/`，再在根目录执行 `npm run build`；该命令会重新生成 SDK 包并更新两个消费者的依赖。根目录 `npm test` 检查适配层和桌面会话。

`remote-connect/` 提供可选远程网络进程与管理入口，独立于 SDK Direct P2P。Mac 打包前需按快照说明生成远程组件；当前资源面向 macOS arm64，其他架构仍需适配与验收。相关历史构建记录保留在 `verification/`，不代表本次合并的验证结果。

## 已验证与交付边界

较早的服务端验证记录为 `make all` 通过（4088 passed，17 skipped），该数字不是本次迁移的最新验证结果。电脑端 SDK、会话、数据流和 Electron 窗口的验证证据见 [电脑端验收记录](docs/verification/wanx-computer-client/README.md)。此前服务端产品管理与工程生成检查见 [原验证记录](docs/verification/wanx-admin-v1/README.md)。

完整前端套件仍存在原始代码可复现的 6 项失败及 3 个文件的测试环境加载失败，详见 [验证记录](docs/verification/wanx-admin-v1/README.md)。

标准电脑端使用 SDK 已定义的 `omnia-desktop` 连接身份；新产品需独立登记身份。当前缺少批准的 Gateway／ICE 发行配置，因此正式 P2P 入口暂不可用。没有真实盒子联调；跨网络连接、真实桌面、Windows 真机安装及生产签名仍需验收。WANX 停机救援和系统恢复需独立维护通道。

## 产品与第三方许可

WANX 产品扩展、SDK 及生成应用是公司私有产品，不以 MIT 对外许可。基础框架与第三方组件保留原有版权、许可和通知，参见 [基础框架许可证](LICENSE)、[基础框架参考说明](README.upstream.md) 及各组件内的第三方声明。第三方许可不因产品定位改变而删除或替换。
