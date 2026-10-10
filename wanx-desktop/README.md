# 万象电脑端

独立 Electron 客户端，复用 WANX Dashboard 功能页面，通过 `centaurai-wanx` 私有适配层及标准 Go SDK 连接盒子里的 WANX 服务端。盒子连接与应用中心是同级客户端入口。

```sh
npm ci --prefix ../sdk-box-management
npm run build --prefix ../sdk-box-management
cd ../dashboard && npm ci
cd ../wanx-desktop && npm ci
npm run build
npm test
npm start
```

发行方按 `deployment.example.json` 安装批准的 `deployment.json`；该文件不进入版本库。缺少 Gateway／ICE 可信主机列表时，平台/P2P 入口禁用。已有服务兼容接入使用可信 HTTPS，回环 HTTP 仅用于开发。凭据由 SDK 安全存储和主进程保管，真实 JWT 不进入页面。

`npm run package:mac` / `npm run package:windows` 生成平台安装包，SDK 原生二进制目录须保持解包。`tools/package-mac-cache.mjs` 可利用已有 Electron 37.10.3 arm64 缓存生成本机开发预览，临时签名不代表生产发行。

详细账号边界、连接流程、应用管理、草稿保存和交付限制见 [电脑端说明](../docs/wanx-client.md)。验收证据见 [验证记录](../docs/verification/wanx-computer-client/README.md)。公司私有产品，第三方许可证保留。

源码适配层位于 `../packages/wanx-client-adapter/`，当前固定包位于根目录 `vendor/`。需要重建原生宿主时按 [快照恢复说明](../SNAPSHOT.md) 准备标准 SDK，再在仓库根目录运行 `npm run build`。可选远程连接资源位于 `../remote-connect/`；Mac 打包前需单独生成对应网络进程，当前打包资源仅验证 macOS arm64。
