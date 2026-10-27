# 万象团队版 · CentaurAI-WanX Studio 1.0.0

团队版与个人版是独立客户端，共用仓库中的 WANX 后端、认证、多租户、模型、空间和应用服务。分支：`wanx1.0`。完整功能与兼容边界见 [1.0 版本说明](../docs/wanx-1.0-release.md)。

管理员可构建应用、管理星图数据仓、邀请成员、验收并内部上架。普通成员使用自己的身份访问获准应用、AI 对话、空间和盒子；客户端与服务器共同校验权限。

## 本地身份安全开关

右上角头像 → **设置 → 本地身份安全**，默认关闭。关闭或重新开启后，需要完全退出并重新启动客户端；保存设置不会切换当前连接。身份锁定页也提供同一个开关。

关闭后不加载本地身份与设备审批，改用既有云账号 SSO 和盒端用户权限；本地身份文件保留，重新开启后可继续使用。设置保存在当前安装的 `userData/identity-security.json`，不影响另一台电脑。

此开关不会创建云端设备授权，也不会解除盒端的强制本地身份策略。云端返回“未获访问权限”时仍需处理对应账号、电脑的授权；已启用强制本地身份策略的盒子不能通过关闭客户端开关改用云 SSO。

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
