# 客户端网络组件打包与更新校验

## 问题与修复

本机带品牌的 Electron 运行包从 `Contents/Resources/app` 加载客户端，
但 Electron 的 `app.isPackaged` 仍为 `false`。旧代码因此在源码布局的
`app/native/bin` 寻找网络引擎，而实际文件位于 `Contents/Resources/network`。
结果是账号正常、盒子已关联，客户端却报 `engine_missing`，无法建立远程连接。

运行时现在同时检查安装目录布局与 `app.isPackaged`：

- `Resources/app`、`Resources/app.asar` 与正式安装包使用 `resources/network`。
- 从外部仓库启动的源码仍使用该仓库的 `native/bin`。
- 网络引擎与设备发现助手使用同一套路径规则。
- Windows 引擎按目标架构选择，发现助手匹配打包配置中的 x64 版本。

没有搜索系统 PATH、借用其他安装目录或绕过账号、盒子授权；更新无需重置账号、重新认领盒子。

## 打包门禁

基础 macOS/Windows 打包与正式客户端打包接入统一 `afterPack` 校验：

1. 必须在交付目录 `resources/network` 找到对应网络引擎和发现助手。
2. 必须是非空普通文件；macOS 还必须有执行权限。
3. 签名前，包内内容必须与本次 `native/bin` 构建输入逐字节一致。
4. 构建平台和架构与目标一致时，从交付目录启动网络引擎，检查其初始
   `status` 为 `disabled`，随后关闭。此检查不读取账号、不入网、不连接盒子。
5. macOS 保留原有 OTA 文件权限处理，之后再签名、生成归档和公证。
6. 正式 macOS 和 Windows 的 `verification-client.json` 记录两项原生组件的名称、字节数及 SHA-256。

签名可能改变 Mach-O/PE 文件字节。因此源文件一致性在签名前检查，最终报告记录签名后的文件哈希；
原有应用签名、发行证书和公证验证继续检查最终产物，不把合法重签误报为内容损坏。

组件缺失、放错位置、被截断、执行权限丢失或与构建输入不一致时，打包直接失败。
Windows x64 内测打包保留既有 PE、网络引擎/发现助手哈希和许可证校验。
异平台或异架构构建仍检查完整性，不声称已执行目标二进制；原生运行验收须在对应平台完成。

## 更新约束

- 交付和安装完整客户端应用包；不要仅用源码覆盖 `Resources/app` 后就宣称完成升级。
- 更新引擎或发现助手时，必须同时交付匹配的 `resources/network`，不能只保留旧组件。
- 原生可执行文件保留在 ASAR 外；源码中的 `native/bin` 为构建输入，不需要再复制一套到 ASAR 中。
- 正式包继续使用既有证书、签名、公证和更新信任校验；本机测试产物不作为正式发行包。

## 回归验证

```sh
npm --prefix wanx-client ci
node --test wanx-client/tests/native-binaries.test.mjs wanx-client/tests/package-client-native.test.mjs
npm --prefix wanx-client test
make all PYTEST_JOBS=2
```

回归覆盖安装版被判为开发模式、正常源码启动、Windows 双架构组件选择、
组件遗漏或放错目录、内容不一致、空文件、非普通文件、执行权限及无账号启动检查。

实际打包验收另用 macOS arm64 交付目录确认 `afterPack` 门禁、原生启动检查和包内哈希；
本轮不发布新安装包，不修改生产收费、账号或盒子配置。

本轮结果：

- `make all PYTEST_JOBS=2` 通过：Ruff、mypy 及后端 4,740 通过／18 跳过。
- 客户端完整测试：1,066 通过／14 跳过；原生 Go 测试通过。
- macOS arm64 实际打包通过；ASAR 中的运行时文件与源码一致，应用签名校验通过。
- 签名前和签名后的交付目录引擎均可执行无账号状态检查。
- 实际打包故意遗漏发现助手时，以 `CLIENT_NATIVE_BINARY_MISSING` 终止。
- Windows 通过目录、双架构配置及发布协议回归；本轮未运行 Windows 实机打包、签名或安装验收。
