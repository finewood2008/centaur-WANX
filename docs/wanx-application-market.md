# WANX 应用市场开发与发布

## 范围与责任

Admin 管理应用资料、发行版本、通用应用包与各平台原生制品、发布指针和操作审计。OSS 只存储文件。WANX 负责识别平台、版本比较、签名与完整文件校验，以及本机安装、启动、更新、回退、卸载；知君是其中一个应用。市场请求复用 Consumer 登录和请求签名，不需要先连盒子；应用启动继续使用既有盒子连接门禁。

知君等共享运行时应用默认发布一份通用 `.wanxapp`，签名描述为 `os: "universal"`、`arch: "universal"`，适用于万象支持的 Windows/macOS、x64/ARM64。万象原生安装包仍按系统与架构区分；旧平台专用 `.wanxapp` 保留精确匹配，不跨架构回退。候选在通用与精确目标发布指针之间选择最新版本，同版本优先精确目标。正式渠道只发布稳定版。软件版本按严格 SemVer 比较，`1.10.0 > 1.9.0`，`1.0.0 > 1.0.0-rc.1`，`+build` 不影响排序。同一版本不能借 buildId 或重新上传变成升级。同版本不同制品返回需重新安装，不自动替换；本机版本较新时不降级。

首期可执行安装类型是第一方 Electron ZIP 包 `.wanxapp`。DMG/EXE 可以在 Admin 中登记、验证和发布，当前 WANX 市场不会执行原生安装器，也未接入 WANX 自身的自动更新。指定账号灰度使用下文的协议 3 受控发行包；静默更新、断点续传、差分下载和第三方应用沙箱不在本期。

## 客户端使用与接口接入

在仓库根目录运行 `npm run start:client` 启动包含应用市场的万象。`npm start` 同样启动 `wanx-client`；旧桌面壳已删除。新客户端打包入口为 `npm run package:client:mac`（应用目录）和 `npm run package:client:windows`（NSIS 安装包）。

登录后应用首页自动加载市场目录并检查本机兼容版本；“刷新与检查更新”重新查询。卡片显示版本、通用包或平台标记、包大小和更新说明。点击安装或更新并确认后，由主进程申请短期下载地址，完成签名、哈希和压缩包校验，再更新已安装列表。安装不要求连接盒子，打开应用时仍要求连接。下架、缺少通用或本平台应用包、底座版本过低、签名错误会显示对应原因。

市场中的应用名称以 Admin 目录为准，按 `applicationId` 匹配并用于已安装卡片、发现列表、详情、精选标签及操作确认。快捷面板的应用名称、打开按钮提示及连接提示使用同一 Admin 目录，登录及重新打开面板时刷新。Admin 改名后刷新即可更新显示，不需要重新安装应用；无可用 Admin 名称时回退到本地名称；目录刷新失败时保留上次成功获取的名称。此规则只改变显示名称，不修改签名清单、已安装版本、应用 ID 或业务数据。

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

已升级到协议 3 的 WANX Host 应用统一使用万象仓库的 `wanx-client/package-app.sh`。在万象仓库根目录运行，例如：

```sh
./wanx-client/package-app.sh --project ../centuarai-wanx-ai-browser --version 0.1.2
./wanx-client/package-app.sh --project ../centuarai-wanx-centaurloop --version 0.10.4
./wanx-client/package-app.sh --project ../centuarai-wanx-zhongjian --version 0.3.5
```

知君和超级参谋团的市场清单仍为协议 1，统一脚本会拒绝打包。须先将各自市场清单升级到协议 3，并验证新版盒端准备接口、现有用户数据的版本兼容与回退限制，再以新版本号打包。半人马环已升级到协议 3；其盒端仍须提供新版 Bridge 准备与就绪接口，以及 Loop 业务接口。旧版安装留下的 Electron 数据需要实机验证升级兼容性。

也可以在仓库外的本机配置文件（例如 `~/.config/wanx-release/zhongjian.json`）写入 `{"version":"0.3.5"}`，调用时加 `--config <文件>`。可选字段为 `out`、`key`、`key-id`、`os`、`arch`；命令行参数优先。未指定 `--config` 时读取应用工程根目录的 `market-release.local.json`（若存在；请确保该文件被 Git 忽略）。版本号来自命令行或本机配置，不改应用源码。默认从 `~/.config/wanx-release/release-private.pem` 读取 Ed25519 私钥，使用 `release-2026` 公钥 ID，输出到忽略 Git 的 `wanx-client/release/market/`。生成同名 `.wanxapp` 和 `.wanxapp.release.json` 后会立即验签并校验哈希；把这两个文件上传到 Admin 对应应用、版本的草稿。同名本地产物会在新包构建并完成归档校验后成对替换，此脚本不上传或上架应用。Admin 中已校验的制品不能覆盖；同一版本的相同平台与架构目标也不能再上传另一份制品。修复或升级发行协议时须创建更高的新版本草稿、重新打包和上传。

统一市场应用约定：工程根目录提供 `market/wanx-app.json`，`package.json` 提供 `build:market-source` 脚本。统一打包器以 `WANX_MARKET_VERSION=<发行版本>` 运行该脚本，读取工程生成的 `dist/application/`，要求其中包含实际入口、运行依赖、`application.manifest.json` 和 `package.json`，且产物版本与发行版本一致。统一打包器随后写入签名市场清单，不按应用 ID 特判目录。新市场发行包的清单必须使用协议 3 并声明 `releaseAccess: "account"`；仅遵守目录约定、但仍使用协议 1/2 的工程须先升级清单。未设置平台与架构限制的共享运行时应用生成通用包。众见的客户端包只包含桌面应用，其盒端业务接口仍需先集成到万象底座。

已有独立构建产物目录也可以直接使用下述低层 `package:application` 命令签名。
上架交付必须携带应用图标、产品 Logo、3–8 张真实产品截图、1–3 张产品介绍海报、介绍文案与素材索引。目录、规格、真实性与脱敏要求见 [WANX 应用上架素材规范](wanx-marketplace-submission-assets.md)。这是提交方和市场人工审核的必交要求；现有打包器／Admin 尚未自动校验或导入素材索引。

准备独立的构建产物目录（包含运行依赖，不含源码私钥、账号文件和开发环境配置）。所有文件必须为普通文件或目录；符号链接、跨平台非法路径、大小写冲突均拒绝。包根目录放 `wanx-app.json`：

```json
{
  "applicationId": "centaurai.wanx.zhijun",
  "name": "知君",
  "version": "1.0.0",
  "protocolVersion": 3,
  "releaseAccess": "account",
  "runtime": "electron",
  "launchMode": "shared",
  "entrypoint": "main.mjs",
  "capabilities": ["identity.read", "http.request", "chat.stream"],
  "description": "知君应用",
  "compatibility": {
    "backendProductId": "wanx",
    "clientRange": ">=0.1.4 <1.0.0",
    "hostProtocolRange": ">=1.0.0 <2.0.0",
    "backendContracts": [],
    "resourceDependencies": [],
    "localDataSchema": {
      "readRange": ">=1.0.0 <2.0.0",
      "writeVersion": "1.0.0"
    }
  }
}
```

`backendContracts` 和 `resourceDependencies` 为空仅表示没有额外声明的盒端接口合同或市场资源包；协议 3 启动仍须连接支持应用准备与就绪接口的盒子。`localDataSchema` 应与应用实际读写的数据格式一致，不能照抄示例后假定旧安装的数据可升级。旧协议 1/2 安装包仍可由支持它们的客户端读取和运行，但不具备指定账号灰度准入能力，不再用于制作新市场发行包。

`capabilities` 只能选择现有 Host 协议能力：`identity.read`、`experts.read`、`experts.select`、`http.request`、`chat.stream`、`files.upload`。该字段保留在已签名清单中作为发行元数据，当前 Host 不按 capability 限权；应用接口权限仍由盒端按当前用户校验，不能将此字段视为应用沙箱。应用通过 `WANX_HOST_*` 环境变量连接独立 Host 会话，不读取 WANX 的账号文件。

入口是导入执行的 Electron main 模块，可使用 `app.whenReady()`；资源路径使用 `import.meta.url` 或应用启动目录，不假定 `app.getAppPath()` 指向应用包。WANX 子进程不会再次启动 WANX 网络栈或争抢其单实例锁。通用包不得包含平台或架构限制（manifest 不填写 `platform`、`arch`，`launchMode` 缺省或为 `shared`），并应只带跨平台代码和资源。含 native Node 依赖的应用仍需显式按目标平台构建与发布，Electron 版本以 WANX 所带版本为准。

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
  --key /secure/wanx-release-private.pem \
  --key-id release-2026 --min-wanx-version 0.1.4 --build-id git-commit-id
```

默认输出 `*-universal-universal.wanxapp` 和配套 `.wanxapp.release.json`，同一份文件覆盖四种受支持的电脑目标。输出目录和私钥必须在输入目录之外，现有输出不能覆盖。确有原生依赖时显式同时指定 `--os macos|windows --arch x64|arm64`。原生安装器可用 `--file <file.dmg|exe> --application-id <id> --version <semver>` 代替 `--source/--out`，且必须指定系统和架构；该签名不能代替 Apple/Windows 平台签名、公证。

签名旁文件包含 `{keyId, descriptorBase64, signatureBase64}`。Ed25519 签署原始描述字节；描述绑定应用、版本、系统、架构、SHA256、字节数、Host 协议、最低 WANX 版本和完整清单。签名不包含自身，不使用包内公钥建立信任。

## 信任与发布

发行前核对 `wanx-client/applications/market-trust.json` 的公钥：`{"keys":{"release-2026":"-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"}}`。这是随 WANX 分发的固定信任根，当前验证流程使用 `release-2026`；空集合会拒绝所有安装，测试 fixture 公钥不得配置成正式信任。Admin 使用相同的 keyId/公钥，但其文件结构为直接映射 `{ "release-2026": "PEM..." }`，通过 `WANX_MARKET_TRUSTED_KEYS_FILE` 配置。

密钥轮换先发布同时信任新旧公钥的 WANX，再用新私钥发布应用。撤下旧公钥会让旧签名版本无法启动或回退，需先安排应用换签版本和底座升级。

Admin 部署步骤见其仓库 `docs/operations/app-market.md`。新应用操作顺序：创建未上架应用 → 创建版本 → 上传协议 3 通用应用包及签名旁文件 → 等待后端验证成功 → 指定账号灰度并验收 → 将同一制品转为正式版本 → 编辑应用上架。无通用包且缺失当前平台制品时显示不可安装。旧签名包不能手动修改平台标签或协议字段；请使用递增的新版本重新生成通用包和签名描述，再上传发布。先部署支持通用包及账号准入的 Admin、WANX 客户端与盒端 Bridge；旧客户端不识别受控发行包，需要更新。

上传使用 15 分钟 OSS 临时 PUT URL，验证由后台读取整个对象执行，验证成功后将已验证的本地字节提升到独立正式对象。浏览器没有 OSS 密钥或正式目录写权限。临时下载链接短期有效；撤销停止签发新链接，已经签发的链接在到期前仍可能有效。

## 本机状态与恢复

程序目录位于 WANX userData 下 `applications/<applicationId>/<artifactId>/`，当前版本和保留的上一版本由 `.current-version.json` 原子记录；兼容读取既有 `.wanx-state.json`，后续更新写入统一记录。下载和解压先写临时目录，完成签名、哈希、路径、清单、入口校验后才原子切换活动指针。启动只使用当前版本；并发打开合并，安装事务按应用串行。准备新版不停止旧进程，下次打开才撤销旧凭证、确认旧进程退出并切换；停止失败阻止替代进程。卸载与显式回退先完成停止，并在操作期间拒绝新启动。新版首次启动失败保留当前版本供重试，不自动回退。

退出或切换账号会作废进行中的操作授权，提交活动指针前再次检查。用户确认后的候选版本若已变化，则要求刷新后重新确认。失败不把半成品标记为已安装；启动恢复清理未提交目录。

应用业务数据使用独立的 `applications/.runtime/<applicationId>/`；既有市场 `application-data/<applicationId>/` 若已存在则继续复用，更新和默认卸载保留。回退是显式切换到保留的上一份已验证安装；并不保证应用数据库迁移可逆，也不等同于已验证应用业务健康。应用自身需要处理账号数据隔离与数据格式兼容。

开发目录安装 IPC 默认关闭，仅在未打包客户端设置 `WANX_ALLOW_DEVELOPMENT_INSTALL=1` 时开放；正常页面不展示此入口，市场安装和市场子进程入口要求验签；已有开发安装仍可沿原入口打开。

## 验证与上线边界

```sh
npm --prefix wanx-client test
npm --prefix wanx-client run build:renderer
make all PYTEST_JOBS=4
```

`wanx-client/tests/fixtures/market-contract-v1.json`（旧平台包）及 `market-contract-universal-v1.json`（通用包）与 Admin 中同名 fixture 内容相同，覆盖真实签名包与版本比较的一致性。修改协议需同步更新两份及两端测试。

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

### 2026-10-12 市场与 launch 生命周期合并验证

合并 `upstream/dev/wanx-client-host-20261012` 的 `d700f7e`，保留并发启动合并、准备中停止回收、单一当前版本和下次打开切换。修复历史版本 candidate 参数、下载授权有效期、关闭时下载取消及 ZIP 目录层级大小写冲突；规范和需求两路复审均无剩余阻塞问题。

- 合并提交内容的客户端测试：356 通过，4 个需环境变量的集成用例跳过。
- 含工作区原有设备发现改动的客户端测试：363 通过，4 跳过。
- 真实 Electron：共享／独立运行时 × ZIP／目录四种组合，以及签名市场包就绪、唤起、升级与停止，共 6 项通过（含父级测试）。
- `build:renderer` 通过；`make all PYTEST_JOBS=4`：4421 通过，17 跳过。

本次仍使用隔离目录、临时测试签名和模拟 Consumer／OSS；没有执行生产账号下载、发布或 Windows 实机验收。

上架交付必须携带应用图标、产品 Logo、3–8 张真实产品截图、1–3 张产品介绍海报、介绍文案与素材索引。目录、规格、真实性与脱敏要求见 [WANX 应用上架素材规范](wanx-marketplace-submission-assets.md)。这是提交方和市场人工审核的必交要求；现有打包器／Admin 尚未自动校验或导入素材索引。
