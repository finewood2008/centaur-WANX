# 万象客户端版本与受控更新

客户端使用 `wanx-client/updates`，不修改 Octop。设置中的版本中心包含客户端实际构建、当前盒子的认证库存、固定升级计划及任务状态。盒子任务通过 Admin 的设备认证服务执行，退出客户端不取消已创建任务。

## 安全默认值

源码模式显示源码内容摘要；内部和身份不明安装包不会接收正式更新。同一个 SemVer 的不同构建不能作为正式升级。客户端发行签名根默认为空，未配置时显示 `UPDATE_NOT_CONFIGURED`，不会下载或安装。没有匹配发行、平台支持证据或近期库存时，不显示“已是最新版”。

正式客户端登录后自动检查更新，此后每小时重查；下载或安装期间跳过自动检查。用户也可主动检查。下载和重启安装仍是两个明确的用户动作。安装前使用已下载目标的 `releaseId` 重新确认发行仍有效、应用兼容、制品摘要和本机安装目录，取得维护锁后保存目标并关闭应用。渠道出现更新版本不会改变该固定目标；目标已撤回、过期、低于新的强制版本门槛或不再满足限制时仍阻止安装。下载完成仅表示已下载。重启后只有产品版本、构建身份、安装目录和 Host 基本初始化全部匹配，才记录成功；中断或启动旧副本显示恢复指引。本机更新恢复结果不因账号恢复或切换被清空。账号、应用包和业务数据不被删除，不执行数据降级。

`electron-updater` 通过自定义 Provider 读取已验签制品，不读取任意远程 `latest.yml`。关闭自动下载、退出时自动安装和降级。有签名 blockmap 与可验证的本地旧包时优先差分下载，否则下载全量包。下载由 SHA-512 校验，安装前额外核对签名发行中的 SHA-256 和大小。macOS 仍由系统校验应用签名；Windows 独立调用本机 Authenticode 验签，确认预期发布者和有效时间戳，下载、缓存复用和安装前均要求成功。PowerShell 不可用、超时或结果不完整返回 `UPDATE_SIGNATURE_VERIFICATION_FAILED`，不采用更新库默认的跳过验签行为。

## 检查更新入口与客户端版别

个人版和团队版的“版本与更新”均保留“检查更新”按钮。正式配置完成的客户端点击后查询当前渠道；开发构建、缺少更新信任配置或安装位置不支持时，点击显示具体原因，不发起下载或安装。截图中的 `development` 表示源码运行，需安装对应版别的正式发行包才能接收在线更新。

正式打包从本版 `package.json` 的 `wanxEdition` 读取 `personal` 或 `team`，核对应用 ID 与包内身份，并写入 `verification-client.json` 的 `edition`。签名工具把同一版别写入发行载荷，客户端再次核对目标版别。个人版正式渠道为 `stable`，团队版为 `stable-studio`；团队版的测试渠道须以 `-studio` 结尾，例如 `home-integration-studio`。专用隔离测试包继续使用本版独立应用 ID 与 `test-client-<test-run-id>`，不进入 Admin 正式发行流程。

Admin 客户端安装包页按个人版、团队版、未标注历史记录分组。选择报告后，版别和应用 ID 必须匹配；选择页面分组不会改变报告身份。个人版使用 `wanx-client/tools/sign-client-release.mjs`，团队版使用 `wanx-team-client/tools/sign-client-release.mjs`。两版可使用同一版本号，各自版别内的版本仍固定制品；测试发行和正式发行的验收不能跨版复用。明确标注团队版的 `stable-studio` 采用正式验收流程。

旧报告有精确可识别应用 ID 时，新工具可读取其版别；身份不足的报告不能由名称或任意渠道猜测。历史未标注的签名载荷、摘要和渠道行为保持不变，界面显示“未标注”，不会自动改写成个人版。请先部署支持版别的 Admin，再使用新版工具上传、签署和登记发行；本变更不自动发布任何安装包。

### 本次版别与更新入口验证（2026-10-27）

两版更新入口、构建报告、签名和版别回归共 199 项通过，2 项 Windows 原生验签用例在 macOS 跳过；`make all PYTEST_JOBS=4` 通过，Python 5,152 项通过、32 项跳过。使用测试密钥和合成制品运行真实签名工具后，两版发行均通过 Admin 前端报告/关联校验及后端验签/合同校验；未构建、安装或发布真实发行包。

客户端全套首次运行存在独立工作树缺少 Python/兄弟仓库环境的集成失败；团队版另有 Node 23 环境解析测试失败，已用原 HEAD 代码复现。因此不将客户端完整 `npm test` 宣称为全绿。MySQL 并发用例需单独配置测试数据库，本地 SQL 锁次序检查不等同真实 MySQL 并发验收。

## 增量下载与每次打包

每个版本、每种操作系统和架构仍只执行一次相应打包命令。自动生成该版本的全量更新文件和 `.blockmap`，无需针对每个旧版本分别打补丁包：

| 平台 | 手动安装文件 | 应用内更新文件 | 增量元数据 |
| --- | --- | --- | --- |
| macOS | 已签名、公证的 DMG | 已签名、公证应用的 ZIP（全量） | 最终 ZIP 的 `.blockmap` |
| Windows | 已签名的 NSIS EXE | 同一份 EXE（全量） | 最终 EXE 的 `.blockmap` |

blockmap 描述全量文件的分块摘要和长度，不包含一套独立安装程序。客户端核对本地旧包和配对 map 后，复用相同块，通过 HTTPS Range 只取得变化部分，重建完整 ZIP / EXE，再走原有整包校验和安装流程。Windows 正式打包启用适合差分的 NSIS 压缩布局；Mac 的 map 在公证、装订票据及最终 ZIP 重建之后生成，避免与实际分发字节不符。

客户端将校验成功的完整更新包和 map 配对缓存到本应用数据目录，供后续更新复用。首次升级、缓存缺失或损坏、旧发行没有 map、map 下载或校验失败、存储服务不支持正确的 `206 Content-Range` 时自动回退全量。取消下载会停止本次更新，不会触发全量重试。节省比例取决于两个包实际相同的字节，版本变化大时可能接近全量；本地仍需要完整安装包和重建空间。

签名发行的 `artifacts[0].blockMap` 可选，内容为 `{url,sizeBytes,sha256}`，与完整文件的 SHA-256 / SHA-512 一起签名。map 最大 16 MiB，旧版无 map 的发行继续全量更新。私有存储使用独立短期下载地址 `downloadUrls["wanx-client.blockmap"]`，不修改签名 URL。存储网关须保留 Range / Content-Range；map 必须作为原始 `application/octet-stream` 返回，不设置 `Content-Encoding: gzip`。

打包生成的 `verification-client.json` 会记录 `updateArtifact.blockMap`。Admin 上传同次构建的报告、ZIP / EXE 和 `.blockmap`，两份文件都校验成功后才能关联发行。签名命令须同时传入固定文件地址与 `--blockmap-url`；有 map 的新报告不能静默省略该参数。只有旧报告的单文件流程可省略 map。强制升级开关与下载方式独立，强制版本也使用同样的增量优先、全量回退流程。

### 2026-10-26 增量下载验证

- 两版差分集成测试 30 项通过。使用真实 `electron-updater` 下载与缓存流程、本机 HTTPS 和固定测试 CA；不关闭 TLS 验证。1 MiB 固定块用例仅下载 64 KiB 变化数据，连同 map 的网络量小于全量的 1/8；真实打包工具对 4 MiB 数据生成的 map 用例也能完成重建，网络量小于全量的 1/4。这些是测试数据结果，不是所有发行包的节省比例承诺。
- 覆盖首次全量建立基线、缓存篡改、map 摘要与结构错误、解压上限、错误/截断/超长 Range、增量摘要不匹配后的全量回退、下载取消、HTTPS 重定向及跨域认证头移除。Mac 的原生安装交接使用替身，未执行 Squirrel / NSIS 实装；Electron 原生重定向事件仍需真机验证。
- `rtk proxy node --test --test-concurrency=4 wanx-{client,team-client}/tests/{client-differential,client-test-feed,client-test-release,client-updates,client-release-tools,box-updates,update-control,update-checks,application-update-guard,renderer-upgrade,ui-state,account-update-context,upgrade-review-client}.test.mjs`：302 通过、2 项 Windows 平台测试跳过、零失败。
- Admin 后端相关回归 329 通过，排除下方已记录的既有 `MissingGreenlet` 用例；最终 OpenAPI 字段与 HTTP smoke 通过。Admin 前端升级及 API 测试 162 通过，`npm run build:prod` 通过。
- `rtk proxy make all` 退出 0：格式、lint、类型检查通过，4,950 项 Python 测试通过、17 跳过。两仓 `git diff --check` 通过，未改变 Octop 或 dashboard 源码。
- 完整个人版 `npm test` 共 2,117 项，2,092 通过、21 跳过，4 项测试辅助进程超时；随后串行复跑这 4 项，2 项通过、2 项重现既有 `LOCAL_BACKUP_DATABASE_SCHEMA_UNSUPPORTED`（Semantica schema 19 与备份适配器 schema 11 不匹配），不再超时。完整团队版共 1,842 项，1,820 通过、21 跳过，仅既有 Node 23.11 本地环境解析用例失败。未将这些完整套件宣称为全绿，未修改无关模块。
- 两版隔离测试服务共 10 项真实 HTTPS 用例通过，包含 ZIP 范围读取、map 绑定和取消后连接回收。独立审查未发现可复现的 P1/P2 问题。未提交、部署或发布本轮改动。

## 强制升级

Admin 的“客户端安装包”上传页可选择“强制升级”，默认关闭。仅正式 ZIP / EXE 更新包支持此选项。上传只保存选择；关联的签名发行必须包含相同的 `forceUpdate` 布尔值，完成验收并推广到对应渠道后才生效。签名命令模板会为强制版本加入 `--force-update`，不能在签署后手工改 JSON。

强制版本的产品版本就是该渠道、操作系统、架构和已验证系统范围内的最低支持版本。服务端从仍有效的已发布强制发行中选取最高门槛，并以候选响应的 `mandatoryRelease` 返回原始签名证明。后续普通发行不降低该门槛；草稿、撤回、过期或不满足客户端升级基线的发行不施加强制要求。只有当前渠道有通过兼容检查且不低于门槛的升级目标时，才向新客户端施加要求。

收到要求后，个人版与团队版持续显示升级页面，并在主进程阻止新应用启动及新的 AI 请求。已打开应用不被强制结束，可保存工作；设置、诊断、账号登录与切换、检查更新和退出仍可用。取消安装确认只取消本次安装，不解除版本要求。客户端下载和安装失败后保留重试入口，也可联系维护人员获取正式安装包。

已验证的强制证明保存在本机更新状态中，重启、账号变化和临时检查失败不会清除尚有效的证明。客户端启动时重新核验签名、有效期、平台和版本；升级至门槛或证明过期后解除要求。成功认证的策略查询会明确返回签名证明或 `mandatoryRelease: null`：当前目标撤回或不再可安装、强制发行撤回、切换到不适用此策略的账号等情况均可解除缓存限制；恢复可安装发行后重新检查会再次执行仍有效的门槛。旧服务省略字段或临时网络错误不能意外清除已知要求。

新正式客户端的认证请求附带主进程提供的 `X-Wanx-Client` 版本与平台上下文。Admin 对新的市场候选、下载、应用使用准入和万象 SSO 授权请求校验要求，以 HTTP 426 / `CLIENT_UPDATE_REQUIRED` 拒绝不满足门槛的新业务请求；客户端收到后重新检查策略。登录、更新及诊断请求不被此校验阻塞。该机制是兼容性控制，不是对可自行修改本地程序的对手的安全防线。

未包含此功能的旧客户端没有策略接收与版本上报能力，需要先安装过渡版本；不能仅靠后台勾选就让所有历史安装自动具备强制升级功能。开发构建继续不接收正式更新。发布前仍需用真实签名包验证下载、安装和重启，不将源码测试当作实装验收。

### 2026-10-26 本地验证

- `rtk proxy make all` 通过：格式、lint、类型检查通过，Python 测试 4,950 通过、17 跳过。
- `rtk proxy node --test --test-concurrency=4 wanx-{client,team-client}/tests/{client-updates,client-release-tools,update-control,update-checks,application-update-guard,renderer-upgrade,ui-state,account-update-context,upgrade-review-client}.test.mjs`：216 通过、2 项 Windows 原生验签测试跳过、零失败。
- 两版全部 renderer 回归 504 通过；Admin 上传、发行界面及模型回归 60 通过，`npm run build:prod` 通过。
- Admin 后端升级、上传、业务拦截、验收与下载回归 276 通过；排除了已用原 HEAD 复现的 `test_upgrade_rollout_guards.py::test_preexisting_published_stable_candidate_is_not_retroactively_revoked`，其既有 ORM 过期读取触发 `MissingGreenlet`。
- 两版完整 `npm test` 并非全绿：个人版 2 个备份用例因兄弟仓库 Semantica schema 19 与备份适配器要求 schema 11 不一致而失败；团队版 1 个本地启动环境用例在 Node 23.11.0 下出现环境变量解析差异。这 3 个失败均已从原 HEAD 隔离复现，未修改无关模块。
- 未部署 Admin、未发布客户端、未启用任何线上强制策略；正式安装包之间的升级实装仍需发布前验收。现有 Admin 仅将精确 `stable` 视为正式渠道，`stable-studio` 等渠道仍受原有测试资格规则约束。

## 构建正式 macOS 过渡客户端

现存不含版本服务的客户端需要先手动安装一次过渡包。将已有生产发行公钥写入受控文件，例如 `/secure/wanx-release-trust.json`，不要使用测试 fixture 的公钥，不要把私钥打进客户端：

```json
{
  "schemaVersion": 1,
  "keys": { "production-release-key-id": "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n" },
  "windowsPublisherNames": []
}
```

在仓库根目录、具备 Developer ID Application 签名证书和已配置 Apple 公证配置的 Mac 上执行：

```sh
rtk proxy ./wanx-client/package-client.sh --version 0.1.5 --arch arm64 \
  --notary-profile WANX-NOTARY --trust-file /secure/wanx-release-trust.json \
  --channel stable --security-epoch 1 --out /release/wanx-client-0.1.5-arm64
```

命令只构建，不上传或推广。生成签名、公证的 DMG、用于更新的 ZIP 及其 `.blockmap`、SHA256SUMS 和 `verification-client.json`。正式模式必须传入非空的 Ed25519 更新公钥文件；不允许生成无法检查更新却标记为正式的包。DMG 和 ZIP 都提交 Apple 公证；ZIP 内应用装订、验证票据后重新归档，最终摘要与 blockmap 取重新归档后的文件。Intel 构建使用 electron-builder 的 `mac/` 目录和 Mach-O 的 `x86_64` 架构名称，Apple Silicon 使用 `mac-arm64/` 和 `arm64`。

包内 `wanxBuild` 固化构建 ID、源提交、渠道和安全代次。正式 macOS 与 Windows 构建前后都检查客户端源码子树没有已跟踪修改或未跟踪文件，并确认 HEAD 未改变；先提交源码再构建，生成目录应位于忽略目录或仓库外。签名发行的 `sourceCommits` 包含该提交。验证报告的 `updateTrust` 记录实际包内公钥的 SHA-256 指纹，发行签名脚本拒绝不在该映射中的密钥 ID 或不匹配的公钥；更新密钥轮换时，新旧包须保留相应受信公钥。`--local` 的本地验证包允许未提交源码，但标记 `sourceDirty:true`、`sourceCommit:null`，不能进入正式自动安装。

两种架构分别构建、分别验证与登记。`supportedOsVersions` 使用目标安装包实际运行时 `os.release()` 的值，不能填写营销名称或默认宣布支持全部版本。

## 固定制品、签名、登记和推广

1. 在 Admin **版本与升级 → 客户端安装包** 选择同次构建的 `verification-client.json`、ZIP（Windows 选 EXE）及报告中的 `.blockmap`，点击“上传并校验”，然后复制两份文件的固定地址。服务端核验文件大小和摘要，保存不可覆盖的制品；全量包最大 2 GiB，map 最大 16 MiB。保留本机验证报告与原文件用于下方签名。DMG、`--local` 和隔离测试包也可上传供手动下载，但不能在该入口关联正式在线更新。
2. 建立实测兼容表 `/release/support.json`。例中的范围只是格式示例，必须换成实际验证结果；已安装的每个本机应用均需匹配一条规则，否则更新会阻止。

```json
{
  "supportedOsVersions": ["25.0.0"],
  "compatibleApplications": [
    { "applicationId": "example.application", "versionRange": ">=1.0.0 <2.0.0" }
  ]
}
```

3. 使用已有生产发行签名密钥生成签名发行描述。该密钥与盒端任务许可签名密钥必须分离；工具不生成私钥、不读取开发者云端凭据，也不覆盖已有输出文件。

```sh
rtk proxy node wanx-client/tools/sign-client-release.mjs \
  --report /release/wanx-client-0.1.5-arm64/verification-client.json \
  --url https://artifacts.example.com/wanx-client/0.1.5/wanx-arm64.zip \
  --blockmap-url https://artifacts.example.com/wanx-client/0.1.5/wanx-arm64.zip.blockmap \
  --key-id production-release-key-id --private-key /secure/wanx-release-private.pem \
  --release-id wanx-client-0.1.5-arm64 --sequence 1 --channel stable \
  --support /release/support.json --expires-at 2026-11-14T00:00:00Z \
  --out /release/wanx-client-0.1.5-arm64.release.json
```

将示例 `--url` 和 `--blockmap-url` 换成上传页面的固定地址，不要使用“下载”按钮生成的 15 分钟临时链接。`sequence` 必须按渠道和平台递增；过期时间必须晚于实际发布时刻。制品元数据过期后需新发行，不覆盖原签名。工具重新读取 ZIP 和 map 核验摘要，并将完整兼容表纳入签名。

`--channel` 可省略，默认使用验证报告中的构建渠道。正式包可对同一制品分别签署测试渠道与 stable 元数据，无需修改报告或重复上传；必须使用不同发行 ID 与相应渠道序号。它不改变安装包内渠道：验收用旧客户端须订阅测试渠道，升级后的目标包仍使用构建时固化的渠道。`--test-only` 的隔离测试包只允许其原有 `test-client-<test-run-id>` 渠道。

4. Admin 配置 `WANX_UPGRADE_RELEASE_PUBLIC_KEYS` 为与客户端一致的 JSON 公钥映射。在上传页面点击“关联签名发行”导入 JSON，服务端核对受信签名与已上传制品，登记为草稿。到“发行目录”先完成同一制品的测试渠道验收，再关联 stable 发行并登记真实安装、重启及旧版本业务验收证据，最后由具有推广权限的管理员确认推广（可由登记人本人操作）。上传与关联都不会自动发布。下列直接 API 命令适用于已完成验收的发行，使用事先安全提供的令牌；默认线上域名的 API 前缀为 `https://boss.nexusaos.qitus.cn/prod-api`。

```sh
rtk proxy curl --fail-with-body -X POST 'https://admin.example.com/nexus/upgrades/releases' \
  -H "Authorization: Bearer $WANX_RELEASE_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @/release/wanx-client-0.1.5-arm64.release.json

rtk proxy curl --fail-with-body -X POST 'https://admin.example.com/nexus/upgrades/releases/wanx-client-0.1.5-arm64/promote' \
  -H "Authorization: Bearer $WANX_APPROVER_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  --data-binary '{"channel":"stable","expectedRevision":0}'
```

`expectedRevision: 0` 仅用于对应渠道尚未推广的初次操作；后续必须使用平台返回的当前修订，不能在冲突后盲目覆盖。签名发行和渠道推广是两项独立记录。撤回发行阻止新的安装确认。

## 正式 Windows NSIS 构建

在具有真实 Authenticode 证书的 Windows 构建机运行独立正式入口。信任文件的 `windowsPublisherNames` 必须包含与证书一致的发布者名称。证书可通过本机证书存储的 SHA-1 指纹选择，适用于已配置的硬件令牌；也可传入现有 PFX/P12 文件并由 CI 密钥环境提供 `WIN_CSC_KEY_PASSWORD`，不将密码放入命令参数或构建配置。

```powershell
rtk proxy node wanx-client/tools/package-client-windows.mjs --version 0.1.5 --arch x64 --out C:\release\wanx-0.1.5-x64 --trust-file C:\secure\wanx-release-trust.json --publisher-name "Actual Certificate Publisher" --certificate-sha1 "ACTUAL_40_HEX_CERTIFICATE_THUMBPRINT" --channel stable --security-epoch 1
```

PFX 模式将 `--certificate-sha1` 替换为 `--certificate-file C:\secure\windows-signing.pfx`。两种证书选择不能混用。缺少真实证书、发布者、信任根、有效时间戳或 Authenticode 验证失败均报错，不降级为未签名正式包。

正式入口强制 `forceCodeSigning`，生成当前用户级 NSIS 安装器，保留安装目录 ACL 检查，不允许自动跨为全机级安装。生成后验证安装器与 `WANX.exe` 的系统签名、发布者和时间戳，再核对包内版本、构建身份及网络组件，最后写 `verification-client.json` 和摘要。该命令只构建，不上传、不安装、不推广。`arm64` 应在对应正式支持系统上单独验证；系统版本仍使用 `os.release()`。

随后使用上文相同的 `sign-client-release.mjs`，改为 Windows 验证报告、不可变 `.exe` URL、`.exe.blockmap` URL、对应系统支持表及独立发行 ID。工具识别 `platform: windows`、`authenticodeVerified: true` 和 `installationScope: per-user`，生成 `platform.os: win32`、`kind: nsis` 的签名发行。上传、登记、验收和推广操作相同。

原有 `shell/package-win.mjs` 保持未签名内部路径，包内标为 `unsigned-internal-only`；不能使用此包验证或宣称正式 Windows OTA 已上线。

## 验证边界

本地自动测试覆盖签名/摘要、元数据防回放、固定版本、二次确认、维护锁、账号/盒子隔离、计划摘要与幂等、延迟回执及退出顺序。真实 macOS/Windows 两个正式安装包之间的系统签名升级、进程中断、安装权限及安装目录场景必须在发布前实测；源码运行或模拟 updater 测试不能替代该门槛。

### 2026-10-15 正式客户端验收前置检查

- 本机存在有效的公司 Developer ID Application 签名身份。
- 发布文档指名的 `wanx-release` 与 `WANX-NOTARY` 公证 profile 均不存在，`WANX_NOTARY_PROFILE` 未配置。需要已有有效 profile，或由持有人通过 `notarytool store-credentials` 设置；不能以本地未公证包代替验收。
- 当前客户端源码仍有未提交及未跟踪改动，正式源码门禁按预期阻止构建。应先审阅并固定发布提交，不覆盖现有改动。
- 当前 SSH、fleet 与客户端发布配置未指明可用的 Windows 正式构建机和 Authenticode 签名证书。必须补充构建机、证书选择及发布者，并在该机器实测；现有未签名内部包不满足要求。
- 打包门禁、Intel 布局、ZIP 公证流程及发行信任根一致性回归已完成。经用户授权，另完成下述未公证独立 Mac 测试包的真实系统安装器升级；仍未安装两个经过公证的正式版本，未推广 stable 渠道。

真实验收采用专用测试渠道和独立安装环境：先安装版本 A、正常登录和打开应用，再登记版本 B；确认只有主动点击检查、下载和安装才发生升级，重启后实际版本、构建 ID、安装位置一致才记成功。还需验证取消、下载中断重试、签名/摘要损坏、候选撤回、磁盘不足，以及账号、已有应用与数据保留；全部通过后才推广正式渠道。老客户端未含更新模块时，先人工安装同一签名主体的过渡版本。

### 基础模块发行兼容

客户端可验签带 `wanx.foundation-modules.v1` 的 `wanx-box` 发行，适用于 `discovery` 和 `p2p` 的 `module-tar` 制品，要求 `minUpdaterVersion >= 1.1.0`，基础制品不接受容器 `imageId`。该扩展不能用于客户端自身发行；未知扩展仍拒绝。设备 `supportedExtensions` 作为能力信息保留，计划基线仍为 `deviceId`、`ownershipEpoch`、`platform`、`components` 四项；Admin 在候选和创建任务时独立检查能力。旧发行及旧计划签名向量保持不变。

盒子实际库存需要独立升级服务认证上报；普通成员只读，升级操作必须 `canUpgrade: true`。应用 v2 的回退还要求真实本地数据 schema 证据；缺少此证据时保持阻止，不把程序清单中的写入版本当作实际数据版本。

官方机制参考：[electron-builder 自动更新](https://www.electron.build/v26/docs/features/auto-update/)、[Windows 签名配置](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/)。完整新接口见 Admin 仓库的 `docs/contracts/wanx-upgrade-v1.md`；旧 OTA、旧 Manager 和市场协议没有被改名为新协议。


## 独立安装器测试包（暂不公证）

正式模式的干净源码、Developer ID、DMG/ZIP 公证和发行签名门禁保持不变。仅显式 `--test` 使用独立应用 `万象升级测试`，bundle ID 为 `ai.centuarai.wanx.client.ota-test`；版本必须为 SemVer 预发布版本，渠道为 `test-client-<test-run-id>`。源码可能包含未提交改动，但报告明确记录 `sourceDirty` 与完整源码 `sourceSnapshot`，构建前后快照变化会失败，不能当作正式提交来源。

测试数据存放在 `Application Support/centuarai-wanx-client-ota-test/<test-run-id>`，更新缓存独立，并且不注册开机启动。测试包使用单独的 Ed25519 公钥与 HTTPS 回环服务证书，证书只固定在该测试进程的 Electron updater 会话中；不添加系统信任，不修改正式客户端与 Admin 的公钥。发行带 `wanx.client-test.v1` 扩展：正式客户端拒绝测试发行，测试客户端也拒绝正式发行与其他测试轮次。

```bash
node tools/package-client.mjs --test --version 0.1.5-test.1 --arch arm64 \
  --test-run-id <本次标识> --test-feed-url https://127.0.0.1:<端口>/ \
  --test-ca <回环服务公开证书.pem> --trust-file <测试发行公钥.json> --out <新目录>
```

`tools/package-client-test-server.mjs` 只监听 `127.0.0.1`，服务固定的测试发行、报告对应的 `/client-update.zip` 及 `/client-update.zip.blockmap`；ZIP 支持单段 Range，map 按原始字节返回。用同轮次制作更高版本后，`tools/sign-client-release.mjs --test-only ... --blockmap-url https://127.0.0.1:<端口>/client-update.zip.blockmap` 签发测试元数据。将低版本复制到独立安装位置，以 `--wanx-test-update` 启动会执行检查、下载、确认安装与正常 Host 退出流程。新版本重启后，以独立数据目录中的 `updates/test-integration-status.json`、`client-state.json`、安装位置及系统签名共同验收；普通启动测试应用不会自动下载安装。连续测试两次升级可在第一次建立完整基线后验证第二次差分下载。

此测试证明本机 MacUpdater/Squirrel 的系统安装器链路，不代表已完成真实 Admin、真实账号、Windows 真机或 Apple 公证验收。测试包不可投放 stable 或交付为正式发行。


macOS 包在 `afterPack`、系统签名前规范暂存包内文件的所有者写权限，并在签名后只读复核。尤其 Go 模块许可证原来的 `0444` 会导致 Squirrel 解包后无法移除隔离属性，安装失败并重启旧版本；测试包实装曾复现此问题。修复不改变文件内容、不跟随符号链接、不改用户当前安装包，也不删除系统隔离机制。


### 2026-10-15 本机实装结果

Apple Silicon / Darwin 25.5.0 上，`0.1.5-test.1` 经独立 HTTPS 入口取得经过 Ed25519 签名的候选，下载 ZIP、核对摘要、正常退出 Host，并由真实 MacUpdater/Squirrel 替换安装为 `0.1.5-test.3`。自动重启后，实际运行版本、包内构建 ID、安装目录身份均匹配目标，客户端记录 `lastResult=succeeded`；隔离数据标记保留，安装后 `codesign --verify --deep --strict` 通过。目标 build ID：`20261015T084758-b97da43ae8a9`。

第一次目标 `0.1.5-test.2` 实装因只读许可证失败，Squirrel 恢复启动旧包；客户端记录 interrupted，未误报成功。修复签名前权限规范化后才完成上述成功升级。两次系统安装日志、最终运行状态及验证报告保存在本机 `wanx-client/release/ota-test-20261015-a1/`；这是忽略目录中的测试证据，不属于正式发行。

本轮 `npm test`：850 项，842 通过，0 失败，8 项因缺少明确指定的原生环境而跳过。本轮未运行会格式化其他脏文件的仓库级 `make all`，不能据此宣称 Octop 全仓检查完成。

Windows 尚缺可用构建/验证主机、签名身份，以及必须通过 Windows SDK 与 .NET Framework 构建的 `wanx-discovery-win32-x64.exe`；没有用缺失蓝牙组件的交叉包替代完整测试。Mac 公证按用户要求暂缓；真实 Admin、真实账号及现有应用数据的端到端验收仍需另行执行。
