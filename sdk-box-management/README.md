# WANX SDK 盒子管理宿主

Octop 版 WANX 的「盒子管理 → 平台盒子管理」实际调用 `@nexusaos/device-management-uni` 1.0.1。SDK 原始源码来自标准仓库提交 `6ff9bfa02f4df9df650a25e7378891d74dbd0b8b`，未经修改；来源与摘要见 `vendor/SOURCE.json`。

SDK 在后台 Node 进程运行。FastAPI 校验当前 WANX 用户和产品作用域后，只发送固定业务动作及服务端确定的用户 ID。SDK 的会话、P-256 私钥、请求签名和刷新令牌均保留在后台内存，按 WANX 用户隔离，不持久化至浏览器或日志；服务重启后重新登录平台账号。

已接入短信登录/退出、盒子列表、OTA 查询/提交、所有权转移记录/创建/接受、支持会话列表/创建/撤销、登录设备列表/撤销，以及 SDK 的 `requestFactoryReset` 提交接口。平台登录不等于 WANX 本地登录，盒子管理使用平台授权目录中的 `deviceId`。升级只接受平台返回的可用 release；写操作需显式确认，清除还需手机号、验证码和 `ERASE`。

恢复出厂当前采用 SDK 的已提供提交接口；SDK 另有 `requestFactoryResetV2`，所需的清除范围摘要与 handoff generation 尚无本产品的读取/确认流程，未把缺失数据编造为默认值。蓝牙发现、Wi-Fi 配网、P2P 连接属于 SDK 的其他模块，不属于本次设备管理模块接入。

## 构建与验证

需要 Node.js 22+ 及已安装的 Dashboard 构建依赖。

```sh
npm ci
npm run build
npm test
# 仓库根目录
uv run --offline --no-sync pytest tests/unit/api/test_box_management.py -q
# dashboard 目录
npm run build
```

`build.mjs` 将 SDK 和宿主打包到 `src/octop/infra/boxes/sdk-host.mjs`，Python wheel 已包含此文件。后台使用 PATH 中的 Node，也可用 `WANX_BOX_SDK_NODE` 指定。平台地址沿用标准 SDK 文档的 `https://boss.nexusaos.qitus.cn/prod-api`，可由服务操作者设置 `WANX_CONSUMER_BASE_URL`；页面不能指定任意上游地址。生产仅允许 HTTPS，拒绝跳转与 URL 凭据。

验证：4 项 SDK 合成测试验证真实 SDK 请求签名、账号隔离、确认边界、升级 release 来源及结果脱敏；5 项 Python 检查验证用户/产品边界、固定动作目录、安全错误和 worker 生命周期；19 项现有导航/连接检查通过。前端构建、相关 ESLint、后端 Ruff 和新增后端文件的严格类型检查通过。当前本机页面和后台状态接口已实际验证；没有进行真实平台登录或真实盒子操作，不能据此认定硬件验收完成。未运行整仓库全部测试。
