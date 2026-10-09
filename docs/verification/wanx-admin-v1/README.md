# WANX 远程客户端 V1 验证记录

日期：2026-10-01。复用原 Dashboard 与 Go/Wails 桌面壳，未提交或推送。所有账号、产品和数据均为本机合成测试，不访问真实盒子或用户私人内容。

## 本轮通过

| 范围           | 结果与记录                                                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 服务端         | `UV_CACHE_DIR=/private/tmp/wanx-admin-uv-cache UV_NO_SYNC=1 make all PYTEST_JOBS=8`：4083 项通过、17 项跳过；Ruff 与 555 个模块的 mypy 通过。见 `make-all.log`                           |
| 前端构建       | `cd dashboard && npm run build`：tsc 与 Vite 通过。见 `dashboard-build.log`                                                                                                              |
| 本轮相关前端   | 43 项通过：地址限制、请求/流关闭、禁止断线写入、权限入口、SDK 序列化与导出、导航、聊天 WebSocket 保持原行为。见 `frontend-focused.log`                                                   |
| SDK            | `0.1.0-alpha.3`；11 项 Node 运行检查与严格类型/负例通过，来源、472 项 HTTP 绑定和原生二进制哈希核对通过。浏览器入口不引入 Node/Electron 进程。见 `sdk-checks.log`                        |
| 桌面壳         | 原 Go/Wails `go test -race ./...` 通过，macOS arm64 production 二进制构建通过。盒子目录持久化、可信地址、健康检查、重定向拒绝和取消连接有测试。见 `desktop-tests.log`                    |
| 浏览器流程     | Chromium 在实际 WANX 路由和临时数据库上完成原登录滑块、创建产品、启用、版本推荐、用户开通、清单导出、SDK 工程 ZIP、断线冻结与重新核验；无 pageerror。见 `browser-acceptance.json` 和截图 |
| 生成工程       | 最终 SDK 包生成的 TypeScript/React/Electron 工程实际安装与构建通过。浏览器下载 ZIP 的清单、文件及 SDK 哈希已核对。见 `generated-project-checks.json`                                     |
| 产品合同与隔离 | v21→v22 保留私人档案、线程及外键；普通账号管理拒绝、跨产品隔离、启停/访问撤销、模板不覆盖、桌面查看/控制权限与持续授权包含在服务端测试中                                                 |

SDK 交付包：`dashboard/vendor/centaurai-wanx-0.1.0-alpha.3.tgz`。

SHA-256：`c7f0bf3a2a2ab3b466a10fc56097fa2bbac44d44dc7aa35736554d206a6249ed`。

生成工程安装跳过 Electron 安装脚本与二进制下载，证明依赖安装和工程构建，不代表安装包或原生运行验收。

## 全量前端尚未全绿

使用 Node 24.19.0 运行完整 Vitest：202 个文件通过，6 个文件失败；1085 项通过、6 项失败，另有 3 个文件因 `DOMMatrix` 缺失而加载失败。

在当前 `HEAD` 的独立临时 Dashboard 副本上对照运行，已复现全部剩余失败：发布专家刷新请求的旧断言、会话测试缺少 `normalizeThreadArtifacts` mock、窄屏菜单断言，以及 PDF/文档测试环境缺少 `DOMMatrix`。本轮没有改动这些既有行为或扩大范围修复。记录在 `frontend-all.log` 与 `frontend-baseline.log`。

本次增加 WebSocket 生命周期注册需要测试替身具备 EventTarget 接口，已修正相关替身并验证该聊天用例通过。系统 Node 25 默认全局 localStorage 与 jsdom 不兼容；完整前端检查使用 bundled Node 24.19.0，未改变产品代码绕过该环境问题。

## 浏览器检查复现

先构建 Dashboard，然后从仓库根目录运行：

```sh
UV_CACHE_DIR=/private/tmp/wanx-admin-uv-cache UV_NO_SYNC=1 uv run python -m docs.verification.wanx-admin-v1.check_remote_client
```

需要 Playwright 与 Chromium。可用 `WANX_TEST_CHROMIUM` 指定本机已安装的 Chromium 可执行文件。脚本监听本机 8898 端口、创建临时数据库与合成账号，结束后关闭服务；不写默认用户数据目录。

## 尚未验收

- 真实账号、正式管理员/产品网络身份、设备签票、Core/统一身份及真实跨网络 P2P；身份仍为 `pending`，相应入口关闭。
- 真实盒子桌面采集、控制与桌面组件维护。
- Windows/macOS 真机安装运行、正式签名、公证与安装包发行。原生 Mac 窗口的完整交互受此前锁屏限制，当前浏览器检查不替代原生检查。
- WANX 停机救援、系统恢复和服务升级不属于本版维护通道。

此前独立 Electron `wanx-admin-desktop/` 仅保留原型；本轮的新入口均在现有 WANX 工作台内。
