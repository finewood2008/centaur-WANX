# 本地万象客户端快照 · 2026-10-10

此分支保存当前本地“万象app”的独立源码快照。分支：`codex/wanx-local-20261010`。版本：客户端 `0.1.0`，私有适配层 `0.1.0-wanx.1`。

原始快照采用独立提交历史，创建时未合并 Codeup `master`；当时主分支核对版本为 `3e0034ce2122e2e4bb1055b87cfed302c42ec71b`。原始快照只包含桌面客户端，不包含 WANX Python 服务端。当前整合后的仓库同时保留 `master` 服务端源码，盒子服务端仍需独立部署。

## 包含内容

- Dashboard、Electron 桌面壳、私有适配层源码、固定 API 合同、测试与第三方许可。
- 远程访问网络进程、Mac 管理服务、界面与部署脚本。
- 当前实际依赖 `vendor/centaurai-wanx-0.1.0-wanx.1-585a760033fa.tgz`，同时供 Dashboard 和 Electron 使用。
- 2026-10-08 的历史来源和构建摘要；这些摘要不替代下面的本次验证。

排除 Node 依赖目录、工具缓存、标准 SDK 独立仓库、安装包、构建产物、本机配置、账号会话、数据库、日志及另一个知君联调工程。标准 SDK 按下述固定提交恢复。文件摘要见 `SOURCE_SNAPSHOT.json`。

## 本次验证

- 私有适配层：12 项测试通过。
- 桌面会话和网关：9 项测试通过。
- 远程管理：3 项测试通过。
- Dashboard TypeScript 检查和 Vite 桌面构建通过；保留原有非阻断的资源体积和混合导入提示。
- 网络进程：`go test ./cmd/wanx-link` 通过。
- `remote-connect` 下 `go test ./...` 会因第三方许可证目录 `licenses/tailscale.com@v1.104.1` 被扫描而失败；本次使用上面的目标包测试，不改变业务源码。
- 纳入源码与本地文件逐字节一致。快照仅补充忽略规则、本说明和文件摘要。

本次没有验证真实平台账号、盒子、公网连接、Windows 安装或正式签名。

## 从源码恢复

需要 Node.js 22+、Go 1.24+、Python 3；若构建远程组件，按其 go.mod 使用 Go 1.27.1+。标准 SDK 私库需要已有读取权限。

```sh
git clone --no-checkout --filter=blob:none --sparse https://codeup.aliyun.com/667637d76d5f7b05cc5d9ed7/nexusaos/nexusaos-centuarai-conn-sdks.git standard-sdk
git -C standard-sdk sparse-checkout set go release/go-connectivity-sdk-0.2.0
git -C standard-sdk checkout 6ff9bfa02f4df9df650a25e7378891d74dbd0b8b
# 以下两步用于当前合并后的仓库（原始客户端快照无此目录）
npm ci --prefix sdk-box-management
npm run build --prefix sdk-box-management
npm --prefix packages/wanx-client-adapter install
npm ci --prefix dashboard
npm ci --prefix wanx-desktop
npm run build
npm test
```

远程组件二进制不提交源码分支。打包 Mac 前需生成相应资源：

```sh
cd remote-connect
mkdir -p bin
GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o bin/wanx-link-darwin-arm64 ./cmd/wanx-link
go test ./cmd/wanx-link
node --test tests/*.test.mjs
cd ..
```

配置批准的 `wanx-desktop/deployment.json` 后按原 README 启动。当前随 vendor 依赖交付的原生宿主仅为 macOS arm64；其他目标应单独构建和验收。远程管理模块仍依赖另行安装的本机知君服务，源码分支不提供该服务或凭据。
