# 万象电脑端验证记录

日期：2026-10-01。当前入口是 `wanx-desktop/`，独立 Electron 界面通过 `centaurai-wanx` SDK 调用盒子。此前的 Wails 远程网页壳、独立管理员原型均不是本轮入口。

## 检查结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `UV_NO_SYNC=1 make all PYTEST_JOBS=8` | Ruff / mypy / 非 live 测试通过；4088 passed，17 skipped | [make-all.log](make-all.log) |
| 相关前端 Vitest 六个文件 | 43 passed | [frontend-tests.log](frontend-tests.log) |
| `wanx-desktop` 的 `npm test` | 9 passed | [sdk-session-tests.log](sdk-session-tests.log) |
| `uv run pytest tests/unit/i18n -q` | 72 passed | [i18n-tests.log](i18n-tests.log) |
| `wanx-desktop` 的 `npm run build` | TypeScript 与独立 Vite 构建通过；保留 975 项依赖许可记录 | [desktop-build.log](desktop-build.log) |
| `make build-frontend` | 服务端 Web 控制台构建通过 | [server-ui-build.log](server-ui-build.log) |
| 相关新增页面 ESLint、`git diff --check` | 通过 | 无错误输出 |
| 真正的 Electron 窗口操作 | 模拟接入、产品创建、本机草稿恢复、断开通过，无页面异常 | [electron-ui.json](electron-ui.json)、[日志](electron-ui.log) |
| macOS arm64 开发包启动 | 已在原生窗口看到“万象电脑端”及两个同级入口 | [打包日志](macos-package.log)、[窗口记录](packaged-window.json) |

## 已证明的边界

- 电脑端加载自己的界面，地址与模拟 WANX 服务地址不同；不加载盒子网页。未连接时两个客户端入口可见；服务端导航不显示这两个客户端入口。
- 旧服务端侧栏偏好只包含对话时，盒子连接与应用中心仍位于客户端功能清单前两项。
- 平台连接门面使用 SDK Host、Consumer 设备 UUID、`omnia-desktop` 身份与可选 `linkExisting`，拒绝编造设备标识。该部分以 SDK Host 替身验证参数和生命周期，不是实际 P2P 联调。
- HTTPS 兼容接入使用真实 SDK HTTP 适配器。合成服务测试证明 JSON、multipart、字节下载、原生 409 状态和桌面 WebSocket 保持传递。页面使用本机随机会话标识，真实 JWT 和续期令牌不暴露到页面存储或响应头。
- 切盒、断开、身份核验中的旧回复与权限撤销不会继续使用旧会话。SDK 连接和流随关闭释放。
- 本机草稿跨存储实例恢复，按盒子、账号、产品隔离；嵌套凭据拒绝保存；读写前重新核验盒子管理权限。
- Electron 隔离测试使用临时用户目录、合成账号、本机模拟服务，没有使用生产凭据或修改真实用户数据。

截图：[盒子连接](computer-boxes.png)、[应用中心](computer-applications.png)。

## 尚未验收

公司批准的 Gateway／ICE 配置尚未提供，正式平台/P2P 入口禁用。真实账号与设备授权、签票、Core、统一身份、跨网络 P2P、实际盒子桌面与输入控制仍待联调。Windows 真机安装、麦克风与硬件权限、macOS 生产签名及公证没有验收。本机 macOS 包仅临时签名。

此前完整前端套件存在原始代码可复现的 6 项失败和 3 个文件的测试环境加载失败，见 [历史验证记录](../wanx-admin-v1/README.md)。本轮没有宣称整个 Vitest 套件通过。
