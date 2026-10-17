# 万象客户端版本与受控更新

客户端使用 `wanx-client/updates`，不修改 Octop。设置中的版本中心包含客户端实际构建、当前盒子的认证库存、固定升级计划及任务状态。盒子任务通过 Admin 的设备认证服务执行，退出客户端不取消已创建任务。

## 安全默认值

源码模式显示源码内容摘要；内部和身份不明安装包不会接收正式更新。同一个 SemVer 的不同构建不能作为正式升级。客户端发行签名根默认为空，未配置时显示 `UPDATE_NOT_CONFIGURED`，不会下载或安装。没有匹配发行、平台支持证据或近期库存时，不显示“已是最新版”。

客户端检查、下载、安装是三个明确动作。安装前使用已下载目标的 `releaseId` 重新确认发行仍有效、应用兼容、制品摘要和本机安装目录，取得维护锁后保存目标并关闭应用。渠道出现更新版本不会改变该固定目标；目标已撤回、过期或不再满足限制时仍阻止安装。下载完成仅表示已下载。重启后只有产品版本、构建身份、安装目录和 Host 基本初始化全部匹配，才记录成功；中断或启动旧副本显示恢复指引。本机更新恢复结果不因账号恢复或切换被清空。账号、应用包和业务数据不被删除，不执行数据降级。

`electron-updater` 通过自定义 Provider 读取已验签制品，不读取任意远程 `latest.yml`。关闭自动下载、退出时自动安装、降级和差分下载。下载由 SHA-512 校验，安装前额外核对签名发行中的 SHA-256 和大小。macOS 仍由系统校验应用签名；Windows 独立调用本机 Authenticode 验签，确认预期发布者和有效时间戳，下载、缓存复用和安装前均要求成功。PowerShell 不可用、超时或结果不完整返回 `UPDATE_SIGNATURE_VERIFICATION_FAILED`，不采用更新库默认的跳过验签行为。

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

命令只构建，不上传或推广。生成签名、公证的 DMG、用于更新的 ZIP、SHA256SUMS 和 `verification-client.json`。正式模式必须传入非空的 Ed25519 更新公钥文件；不允许生成无法检查更新却标记为正式的包。DMG 和 ZIP 都提交 Apple 公证；ZIP 内应用装订、验证票据后重新归档，最终摘要取重新归档后的文件。Intel 构建使用 electron-builder 的 `mac/` 目录和 Mach-O 的 `x86_64` 架构名称，Apple Silicon 使用 `mac-arm64/` 和 `arm64`。

包内 `wanxBuild` 固化构建 ID、源提交、渠道和安全代次。正式 macOS 与 Windows 构建前后都检查客户端源码子树没有已跟踪修改或未跟踪文件，并确认 HEAD 未改变；先提交源码再构建，生成目录应位于忽略目录或仓库外。签名发行的 `sourceCommits` 包含该提交。验证报告的 `updateTrust` 记录实际包内公钥的 SHA-256 指纹，发行签名脚本拒绝不在该映射中的密钥 ID 或不匹配的公钥；更新密钥轮换时，新旧包须保留相应受信公钥。`--local` 的本地验证包允许未提交源码，但标记 `sourceDirty:true`、`sourceCommit:null`，不能进入正式自动安装。

两种架构分别构建、分别验证与登记。`supportedOsVersions` 使用目标安装包实际运行时 `os.release()` 的值，不能填写营销名称或默认宣布支持全部版本。

## 固定制品、签名、登记和推广

1. 将 ZIP 上传到受控、不可覆盖的 HTTPS 制品地址，保留验证报告。不要复用旧版本的路径或字节。
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
  --key-id production-release-key-id --private-key /secure/wanx-release-private.pem \
  --release-id wanx-client-0.1.5-arm64 --sequence 1 \
  --support /release/support.json --expires-at 2026-11-14T00:00:00Z \
  --out /release/wanx-client-0.1.5-arm64.release.json
```

`sequence` 必须按渠道和平台递增；过期时间必须晚于实际发布时刻。制品元数据过期后需新发行，不覆盖原签名。工具重新读取 ZIP 核验摘要，并将完整兼容表纳入签名。

4. Admin 配置 `WANX_UPGRADE_RELEASE_PUBLIC_KEYS` 为与客户端一致的 JSON 公钥映射。正式发布管理员登记；另一名拥有推广权限的管理员审核并推广。下列命令使用事先安全提供的令牌，不把令牌写入文件。将域名替换为实际 Admin 域名。

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

随后使用上文相同的 `sign-client-release.mjs`，改为 Windows 验证报告、不可变 `.exe` URL、对应系统支持表及独立发行 ID。工具识别 `platform: windows`、`authenticodeVerified: true` 和 `installationScope: per-user`，生成 `platform.os: win32`、`kind: nsis` 的签名发行。登记和双人推广操作相同。

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

`tools/package-client-test-server.mjs` 只监听 `127.0.0.1`，只服务固定的测试发行与其报告中校验过的 ZIP。用同轮次制作更高版本后，`tools/sign-client-release.mjs --test-only ...` 签发测试元数据。将低版本复制到独立安装位置，以 `--wanx-test-update` 启动会执行检查、下载、确认安装与正常 Host 退出流程。新版本重启后，以独立数据目录中的 `updates/test-integration-status.json`、`client-state.json`、安装位置及系统签名共同验收；普通启动测试应用不会自动下载安装。

此测试证明本机 MacUpdater/Squirrel 的系统安装器链路，不代表已完成真实 Admin、真实账号、Windows 真机或 Apple 公证验收。测试包不可投放 stable 或交付为正式发行。


macOS 包在 `afterPack`、系统签名前规范暂存包内文件的所有者写权限，并在签名后只读复核。尤其 Go 模块许可证原来的 `0444` 会导致 Squirrel 解包后无法移除隔离属性，安装失败并重启旧版本；测试包实装曾复现此问题。修复不改变文件内容、不跟随符号链接、不改用户当前安装包，也不删除系统隔离机制。


### 2026-10-15 本机实装结果

Apple Silicon / Darwin 25.5.0 上，`0.1.5-test.1` 经独立 HTTPS 入口取得经过 Ed25519 签名的候选，下载 ZIP、核对摘要、正常退出 Host，并由真实 MacUpdater/Squirrel 替换安装为 `0.1.5-test.3`。自动重启后，实际运行版本、包内构建 ID、安装目录身份均匹配目标，客户端记录 `lastResult=succeeded`；隔离数据标记保留，安装后 `codesign --verify --deep --strict` 通过。目标 build ID：`20261015T084758-b97da43ae8a9`。

第一次目标 `0.1.5-test.2` 实装因只读许可证失败，Squirrel 恢复启动旧包；客户端记录 interrupted，未误报成功。修复签名前权限规范化后才完成上述成功升级。两次系统安装日志、最终运行状态及验证报告保存在本机 `wanx-client/release/ota-test-20261015-a1/`；这是忽略目录中的测试证据，不属于正式发行。

本轮 `npm test`：850 项，842 通过，0 失败，8 项因缺少明确指定的原生环境而跳过。本轮未运行会格式化其他脏文件的仓库级 `make all`，不能据此宣称 Octop 全仓检查完成。

Windows 尚缺可用构建/验证主机、签名身份，以及必须通过 Windows SDK 与 .NET Framework 构建的 `wanx-discovery-win32-x64.exe`；没有用缺失蓝牙组件的交叉包替代完整测试。Mac 公证按用户要求暂缓；真实 Admin、真实账号及现有应用数据的端到端验收仍需另行执行。
