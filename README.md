# 半人马AI-万象 · CentaurAI-WANX

WANX 服务端运行在盒子中，负责账号、配置、Agent、记忆和用户数据。**万象电脑端**位于 `wanx-client/`，负责盒子管理、连接和应用运行。Dashboard 提供盒端业务控制台。

当前万象底座与应用市场代码位于 `wanx-client/`，通过 Consumer 账号查询已上架应用、检查版本和下载安装 `.wanxapp`，连接盒子后启动应用。在仓库根目录运行 `npm run start:client`；macOS 和 Windows 打包分别使用 `npm run package:client:mac`、`npm run package:client:windows`。macOS 此命令输出应用目录。详细使用见 [客户端说明](wanx-client/README.md) 和 [应用市场说明](docs/wanx-application-market.md)。

旧 `wanx-desktop/` 和 `wanx-admin-desktop/` 已删除。根目录 `npm start`、`npm test`、`npm run package:mac`、`npm run package:windows` 均指向 `wanx-client/`。Dashboard 不再提供盒子管理或 `/boxes` 路由；盒子统一在 wanx-client 中管理。

## 客户端个人资料与积分入口

本分支增加右上角头像与个人资料、独立积分页和新版快捷面板；头像昵称按万象账号保存在本机，积分读取权威账号账本，充值保持关闭。接入配置、兼容范围、验证与回退见 [客户端交付说明](docs/wanx-client-profile-credits-panel.md)。

## 本次 GitHub 迁移

本仓库已从旧 DSH 版切换为 Octop 定制版 WANX。旧版提交记录保留，迁移前版本位于 `backup/dsh-before-octop-20261009`。源工程基础提交为 `7d84a99`，同时包含本地现有的 WANX 平台扩展与盒子管理源码。仓库保持私有，包含构建所需的私有 SDK 依赖，不包含本机账号、会话、数据库、日志或安装包。

平台盒子管理由 wanx-client 承担；Octop 原有代码、功能和交付流程保留。当前客户端能力与操作流程以 [wanx-client 说明](wanx-client/README.md) 为准。

## 当前客户端

- **盒子连接**：在 wanx-client 登录平台账号、选择已关联的盒子，通过内置网络连接和盒端免登录流程进入服务。切盒释放旧会话和数据流，重新核验权限。
- **原有配置**：继续使用模型、存储、连接器、技能、插件、安全、账号、审计和远程桌面页面，按服务端权限显示。
- **应用中心**：注册产品定义、Agent 模板和所需资源；配置盒子部署与启停；登记安装包版本和推荐版本；开通用户访问；导入、导出清单及生成 SDK 工程。
- **用户隔离**：管理接口仅返回产品与授权元数据。私人实例继续由 WANX 原生模块管理，产品停用不删除用户资料，模板更新不覆盖已有实例。

电脑端通过菜单栏面板和管理窗口提供应用与盒子入口；盒子控制台按需加载盒子自身的 Dashboard。客户端不在电脑上启动 WANX 服务端。

当前入口与依赖说明见 [WANX 客户端说明](docs/wanx-client.md)；待实现的员工运维授权要求见 [身份边界](docs/wanx-admin-v1.md)。

## 构建

```sh
uv sync --frozen
npm ci --prefix dashboard
make all
npm run build --prefix dashboard
# 本地 Web 控制台
uv run octop run --host 127.0.0.1 --port 8088
```

独立电脑端：

```sh
npm ci --prefix wanx-client
npm test
npm start
# 安装包：npm run package:mac / npm run package:windows
```

盒子后端保留现有 Python 包名与 CLI，使用 `uv run octop run` 启动。`make build-frontend` 构建服务端 Web 控制台。Dashboard 的应用管理 API 和工程导出仍依赖顶层 `vendor/centaurai-wanx-0.1.0-wanx.1-585a760033fa.tgz`，该目录不能删除；适配层源码位于 `packages/wanx-client-adapter/`。wanx-client 使用自己目录下的 `vendor/` 依赖。

## SDK 重建与验证

需要重建 Dashboard SDK 时，按 [固定版本与重建步骤](docs/wanx-client.md#重建-dashboard-sdk) 准备 `standard-sdk/`，再运行根目录 `npm run build`。该命令会生成 SDK 包、更新 Dashboard 依赖并构建 Web 控制台；根目录 `npm test` 检查当前 wanx-client。

客户端的网络、盒端免登录部署与真机验收要求见 [自动入网部署说明](docs/wanx-auto-p2p-deployment.md)。功能范围、隔离约束及检查命令见 [客户端说明](docs/wanx-client.md)。构建和合成测试不代表真实盒子、公网连接、Windows 运行或签名公证已经验收。

## 产品与第三方许可

WANX 产品扩展、SDK 及生成应用是公司私有产品，不以 MIT 对外许可。基础框架与第三方组件保留原有版权、许可和通知，参见 [基础框架许可证](LICENSE)、[基础框架参考说明](README.upstream.md) 及各组件内的第三方声明。第三方许可不因产品定位改变而删除或替换。
