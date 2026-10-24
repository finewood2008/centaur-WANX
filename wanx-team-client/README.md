# 万象团队版 · CentaurAI-WanX Studio 1.0.0

团队版与个人版是独立客户端，共用仓库中的 WANX 后端、认证、多租户、模型、空间和应用服务。分支：`wanx1.0`。完整功能与兼容边界见 [1.0 版本说明](../docs/wanx-1.0-release.md)。

管理员可构建应用、管理星图数据仓、邀请成员、验收并内部上架。普通成员使用自己的身份访问获准应用、AI 对话、空间和盒子；客户端与服务器共同校验权限。

## 开发

```sh
npm --prefix ../wanx-studio ci
npm ci
npm start
```

启动前自动从 `../wanx-studio/` 生成 Builder、星图和受信桥，生成目录已加入忽略。个人版入口为 `../wanx-client/`。两个客户端具有独立安装标识和配置目录，团队版的更新渠道为 `stable-studio`。

连接诊断默认写入 `userData/logs/connection-timings.jsonl`（macOS 团队版目录为 `~/Library/Application Support/wanx-studio-team-client/`）。`box.connect` 是单次连接总耗时，同次连接用随机 `connectionId` 关联；各阶段及有效租约内沿用地址、实时鉴权、旧地址刷新一次的规则见[连接耗时诊断](../wanx-client/README.md#启动耗时诊断)。两个客户端的连接源码独立维护，优化和回归测试须同步验证。

## 构建与检查

```sh
npm run build:studio
npm run build:renderer
npm test
```

macOS：`npm run package:mac`；Windows：`npm run package:windows`。正式发行继续使用 `tools/package-client.mjs` 和 `tools/package-client-windows.mjs` 的签名、公证与更新信任校验。构建资源从源码生成，安装包和运行数据不提交。

星图仓库 Key 与空间 MCP 授权分别由受信服务管理，不写入应用源码。已配置的团队数据与个人数据分开；未获准仓库、账号停用与跨团队请求应被拒绝。
