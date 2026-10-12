# WANX 应用市场开发与发布

## 范围与责任

Admin 管理应用资料、发行版本、各平台制品、发布指针和操作审计。OSS 只存储文件。WANX 负责识别平台、版本比较、签名与完整文件校验，以及本机安装、启动、更新、回退、卸载；知君是其中一个应用。市场请求复用 Consumer 登录和请求签名，不需要先连盒子；应用启动继续使用既有盒子连接门禁。

首期支持 `macos / windows` × `x64 / arm64`，精确匹配，不跨架构回退。正式渠道只发布稳定版。软件版本按严格 SemVer 比较，`1.10.0 > 1.9.0`，`1.0.0 > 1.0.0-rc.1`，`+build` 不影响排序。同一版本不能借 buildId 或重新上传变成升级。同版本不同制品返回需重新安装，不自动替换；本机版本较新时不降级。

首期可执行安装类型是第一方 Electron ZIP 包 `.wanxapp`。DMG/EXE 可以在 Admin 中登记、验证和发布，当前 WANX 市场不会执行原生安装器，也未接入 WANX 自身的自动更新。灰度、静默更新、断点续传、差分下载和第三方应用沙箱不在本期。

## 客户端使用与接口接入

在仓库根目录运行 `npm run start:client` 启动包含应用市场的万象。`npm start` 仍启动保留的 `wanx-desktop`。新客户端打包入口为 `npm run package:client:mac`（应用目录）和 `npm run package:client:windows`（NSIS 安装包）。

登录后应用首页自动加载市场目录并检查本机兼容版本；“刷新与检查更新”重新查询。卡片显示版本、平台、包大小和更新说明。点击安装或更新并确认后，由主进程申请短期下载地址，完成签名、哈希和压缩包校验，再更新已安装列表。安装不要求连接盒子，打开应用时仍要求连接。下架、缺少本平台安装包、底座版本过低、签名错误会显示对应原因。

市场 HTTP 复用 `account.request` 的 Consumer JWT、EC 请求签名和 token 刷新，默认 Base URL 是 `https://boss.nexusaos.qitus.cn/prod-api`。签名中的路径不带 `/prod-api`。

| 用途 | 接口 | 结果 |
| --- | --- | --- |
| 目录 | `GET /app-api/market/apps` | `items` 中的应用资料；仅返回已上架应用 |
| 本机候选 | `POST /app-api/market/apps/{applicationId}/candidate` | `status`、`reason`、`release.version/notes`、`artifact` 与签名信封 |
| 下载授权 | `POST /app-api/market/artifacts/{artifactId}/download`，正文 `{}` | `url`、`expiresAt`，当前有效期 300 秒 |

候选请求包含 `os`、`arch`、`wanxVersion`、`hostProtocol: 1`；已安装时传 `currentVersion` 和 `currentArtifactId`。OSS 下载不附加平台登录头。更新前重新查询候选，制品变化时需刷新并重新确认。完整服务端合同位于 Admin 仓库 `docs/contracts/wanx-app-market-api.md`。

如果刚发布的知君没有出现在目录中，在 Admin 应用列表点击“编辑资料”，打开“在应用市场上架”并保存；发布版本不会自动上架应用。

本次客户端接入验证：`npm --prefix wanx-client test` 272 项通过，`build:renderer` 通过，`make all PYTEST_JOBS=4` 4421 项通过、17 项跳过。真实 Electron 窗口通过 renderer → preload → IPC → 市场模块完成签名测试包安装和卸载；原有知君 0.4.2 发行包也通过当前代码的验签、完整性检查和隔离目录安装。HTTP 集成测试使用模拟 Consumer/OSS，未代表生产账号与 OSS 实连验收；本次没有重新生成安装包。

## 制作应用包

准备独立的构建产物目录（包含运行依赖，不含源码私钥、账号文件和开发环境配置）。所有文件必须为普通文件或目录；符号链接、跨平台非法路径、大小写冲突均拒绝。包根目录放 `wanx-app.json`：

```json
{
  "applicationId": "centaurai.wanx.zhijun",
  "name": "知君",
  "version": "1.0.0",
  "protocolVersion": 1,
  "runtime": "electron",
  "entrypoint": "main.mjs",
  "capabilities": ["identity.read", "http.request", "chat.stream"],
  "description": "知君应用"
}
```

`capabilities` 只能选择现有 Host 协议能力：`identity.read`、`experts.read`、`experts.select`、`http.request`、`chat.stream`、`files.upload`。能力来自已签名清单。应用通过 `WANX_HOST_*` 环境变量连接独立 Host 会话，不读取 WANX 的账号文件。

入口是导入执行的 Electron main 模块，可使用 `app.whenReady()`；资源路径使用 `import.meta.url` 或应用启动目录，不假定 `app.getAppPath()` 指向应用包。WANX 子进程不会再次启动 WANX 网络栈或争抢其单实例锁。需要针对目标平台构建 native Node 依赖，Electron 版本以 WANX 所带版本为准。

由发行环境生成并保存 Ed25519 私钥（不要提交至代码库）：

```sh
openssl genpkey -algorithm ED25519 -out /secure/wanx-release-private.pem
openssl pkey -in /secure/wanx-release-private.pem -pubout -out /secure/wanx-release-public.pem
```

在 `wanx-client` 目录运行：

下方 `/build/zhijun`、`/release/zhijun` 和 `/secure/...` 都是示例路径，需要替换成实际路径。`package:application` 只封包和签名，不会构建知君、生成应用入口或完成 WANX Host 接入。输入目录必须已存在，并包含 `wanx-app.json`、入口文件和运行依赖；不能直接把未经适配的独立桌面应用源码目录当作输入。

```sh
npm ci
npm run package:application -- --source /build/zhijun --out /release/zhijun \
  --os macos --arch arm64 --key /secure/wanx-release-private.pem \
  --key-id release-2026 --min-wanx-version 0.1.0 --build-id git-commit-id
```

输出 `.wanxapp` 和 `.wanxapp.release.json`。输出目录和私钥必须在输入目录之外，现有输出不能覆盖。为 macOS Intel 使用 `--arch x64`，Windows 使用 `--os windows`。原生安装器可用 `--file <file.dmg|exe> --application-id <id> --version <semver>` 代替 `--source/--out` 生成签名旁文件；该签名不能代替 Apple/Windows 平台签名、公证。

签名旁文件包含 `{keyId, descriptorBase64, signatureBase64}`。Ed25519 签署原始描述字节；描述绑定应用、版本、系统、架构、SHA256、字节数、Host 协议、最低 WANX 版本和完整清单。签名不包含自身，不使用包内公钥建立信任。

## 信任与发布

发行前核对 `wanx-client/applications/market-trust.json` 的公钥：`{"keys":{"release-2026":"-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"}}`。这是随 WANX 分发的固定信任根，当前验证流程使用 `release-2026`；空集合会拒绝所有安装，测试 fixture 公钥不得配置成正式信任。Admin 使用相同的 keyId/公钥，但其文件结构为直接映射 `{ "release-2026": "PEM..." }`，通过 `WANX_MARKET_TRUSTED_KEYS_FILE` 配置。

密钥轮换先发布同时信任新旧公钥的 WANX，再用新私钥发布应用。撤下旧公钥会让旧签名版本无法启动或回退，需先安排应用换签版本和底座升级。

Admin 部署步骤见其仓库 `docs/operations/app-market.md`。操作顺序：创建未上架应用 → 创建版本 → 分别上传各平台的签名旁文件与包 → 等待后端验证成功 → 发布版本 → 编辑应用上架。缺失平台显示不兼容，不会选另一个安装包。

上传使用 15 分钟 OSS 临时 PUT URL，验证由后台读取整个对象执行，验证成功后将已验证的本地字节提升到独立正式对象。浏览器没有 OSS 密钥或正式目录写权限。临时下载链接短期有效；撤销停止签发新链接，已经签发的链接在到期前仍可能有效。

## 本机状态与恢复

程序目录位于 WANX userData 下 `applications/<applicationId>/<artifactId>/`，活动指针和上一版本位于 `.wanx-state.json`。下载和解压先写临时目录，完成签名、哈希、路径、清单、入口校验后才原子切换活动指针。启动只使用当前版本，安装、启动、卸载和回退按应用互斥。

退出或切换账号会作废进行中的操作授权，提交活动指针前再次检查。用户确认后的候选版本若已变化，则要求刷新后重新确认。失败不把半成品标记为已安装；启动恢复清理未提交目录。

应用业务数据位于 WANX userData 下 `application-data/<applicationId>/`，更新和默认卸载保留。回退是显式切换到保留的上一份已验证安装；并不保证应用数据库迁移可逆，也不等同于已验证应用业务健康。应用自身需要处理账号数据隔离与数据格式兼容。

开发目录安装 IPC 默认关闭，仅在未打包客户端设置 `WANX_ALLOW_DEVELOPMENT_INSTALL=1` 时开放；正常页面不展示此入口，正式运行入口仍要求签名包。

## 验证与上线边界

```sh
npm --prefix wanx-client test
npm --prefix wanx-client run build:renderer
make all PYTEST_JOBS=4
```

`wanx-client/tests/fixtures/market-contract-v1.json` 与 Admin 中同名 fixture 内容相同，覆盖真实签名包与版本比较的一致性。修改协议需同步更新两份及两端测试。

本地验证使用临时目录、测试签名和模拟 OSS，没有执行生产迁移或配置生产公钥。上线前还需用真实私有 OSS、MySQL 和目标系统安装环境完成验收；本次开发不代表 Windows 实机、macOS 签名公证或生产环境已经验收。

### 2026-10-12 开发验收记录

| 检查 | 结果 |
| --- | --- |
| WANX `npm test` | 248 通过 |
| WANX `build:renderer` | 通过 |
| 仓库 `make all PYTEST_JOBS=4` | lint/typecheck 通过；4421 测试通过，17 跳过 |
| Admin 市场后端及跨语言合同 | 78 通过 |
| Admin 市场页面测试 | 17 通过 |
| Admin `build:prod` | 通过 |
| 真实 Electron 37.10.3 | 临时签名包安装、外部 ESM 入口导入、隐藏窗口加载及独立 userData 验证通过；退出码 0 |

Admin 后端全量测试为 2413 通过、12 跳过、15 失败；失败全部在既有 `test_consumer_reset_v1.py`，报设备证书不可用。将未修改 HEAD 导出至独立临时目录后复跑该文件，同样 15 失败、8 通过，确认与市场变更无关。Admin 前端全量为 202 通过、1 失败，既有 `deviceIdentityRuntime.test.js:54` 仍断言旧设备文案；相关测试和页面均未改动。未绕过或修改这些既有断言。

独立审查发现的 MySQL 陈旧快照、回退后再次升级目录冲突、启动与安装竞态均已修复并复核；真实 MySQL 双事务和 OSS 在线联调仍属于上线验收。
