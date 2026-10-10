# 半人马AI-万象 · CentaurAI-WANX

WANX 服务端运行在盒子中，负责账号、配置、Agent、记忆和用户数据。**万象电脑端**在笔记本上运行独立的客户端界面，通过 `centaurai-wanx` SDK 联入盒子。知君及其他产品使用同一个通用 SDK，并拥有各自的应用身份和用户实例。

当前电脑端代码位于 `wanx-desktop/`，使用 Electron 封装并复用原 Dashboard 的功能页面。电脑端保留盒子连接、应用中心两个入口；本次 Octop Web 控制台新增「盒子管理」主导航，包含 SDK 平台管理和已有地址连接。管理员权限由选中的盒子决定。此前 Go/Wails 远程网页壳和独立管理员原型保留作历史参考。

## 本次 GitHub 迁移

本仓库已从旧 DSH 版切换为 Octop 定制版 WANX。旧版提交记录保留，迁移前版本位于 `backup/dsh-before-octop-20261009`。源工程基础提交为 `7d84a99`，同时包含本地现有的 WANX 平台扩展与盒子管理源码。仓库保持私有，包含构建所需的私有 SDK 依赖，不包含本机账号、会话、数据库、日志或安装包。

「盒子管理」已接入 SDK 的平台账号、设备目录、OTA、转移、支持会话及登录设备管理；具体能力和限制见 [SDK 盒子管理说明](sdk-box-management/README.md)。依据 SDK 的 bootstrap 就绪状态、Direct 连接、统一身份及 V2 清除流程重新设计的方案尚未全部实现，不代表真实盒子已经完成联调。

## 当前 Octop 底座

已合入 Octop **1.0.2b6** 及官方主分支提交 [`0c5a46ab`](https://github.com/TencentCloud/Octop/commit/0c5a46ab5f82e5ad9d1a56fa09b00e542f042fda)（2026-10-10 上传前核对）。新增远程专家 Bridge、LDAP、Agently CLI 连接器和技能复制策略，并保留 WANX 品牌、SDK 盒子管理、原生记忆及应用隔离。

数据库迁移沿用 WANX 的既有编号：上游 Bridge / 技能策略分别映射到 024 / 025，避免覆盖已经部署的 019–023。完整来源、合并处理和验证边界见 [上游合并记录](docs/development/wanx-upstream-20261010.md)。源码更新不代表已有安装包或运行服务已升级。

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
cd dashboard && npm ci
cd ../wanx-desktop
npm ci
npm run build
npm test
npm start
# 安装包：npm run package:mac / npm run package:windows
```

盒子后端保留现有 Python 包名与 CLI，使用 `uv run octop run` 启动。`make build-frontend` 构建服务端 Web 控制台；`wanx-desktop` 的构建生成独立电脑端资源。SDK 固定依赖位于 `dashboard/vendor/`。发行方必须配置批准的 Consumer、Gateway、ICE 主机，见 [电脑端说明](docs/wanx-client.md)。

## 已验证与交付边界

较早的服务端验证记录为 `make all` 通过（4088 passed，17 skipped），该数字不是本次迁移的最新验证结果。电脑端 SDK、会话、数据流和 Electron 窗口的验证证据见 [电脑端验收记录](docs/verification/wanx-computer-client/README.md)。此前服务端产品管理与工程生成检查见 [原验证记录](docs/verification/wanx-admin-v1/README.md)。

完整前端套件仍存在原始代码可复现的 6 项失败及 3 个文件的测试环境加载失败，详见 [验证记录](docs/verification/wanx-admin-v1/README.md)。

标准电脑端使用 SDK 已定义的 `omnia-desktop` 连接身份；新产品需独立登记身份。当前缺少批准的 Gateway／ICE 发行配置，因此正式 P2P 入口暂不可用。没有真实盒子联调；跨网络连接、真实桌面、Windows 真机安装及生产签名仍需验收。WANX 停机救援和系统恢复需独立维护通道。

## 产品与第三方许可

WANX 产品扩展、SDK 及生成应用是公司私有产品，不以 MIT 对外许可。基础框架与第三方组件保留原有版权、许可和通知，参见 [基础框架许可证](LICENSE)、[基础框架参考说明](README.upstream.md) 及各组件内的第三方声明。第三方许可不因产品定位改变而删除或替换。
