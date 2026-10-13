# 公司运维与客户身份边界

## 2026-10-13：公司运维与客户身份边界（待实现）

当前客户入口为 `wanx-client/` 的应用首页与设置；
公司运维人员和客户盒子所有者必须使用不同的授权链路。客户 Owner 当前会被映射为
Octop `admin`，所以 `role=admin`、`knowledge_settings` 或本机配置都不能作为公司运维资格。

推荐在 BOSS 设备详情提供「打开运维后台」，由 BOSS 员工登录及独立权限
`nexus:device:wanx-console` 控制，客户万象不增加内部 Dashboard 按钮。
该入口尚未实现，不能通过给客户增加 Octop 权限替代。

后续需要 Admin 和 WANX bridge 配套实现：

1. BOSS 校验员工身份、授权设备范围及客户设备的有效临时支持授权。
2. 签发短期、一次性运维票据，独立 audience，绑定操作员、设备、scope、支持会话、
   到期时间及 jti；票据不得复用 Consumer SSO 的客户角色。
3. Bridge 验签并兑换独立运维会话，不覆盖客户 Owner 的本地身份。
4. 过期、撤销及跨设备访问拒绝；记录操作员、目标设备与操作审计。

验收必须覆盖客户 Owner/admin 无法申请运维票据，以及过期、重放、撤销和跨设备拒绝。
当前仅核对了现有 BOSS 员工认证、`nexus:device:remote-support` 权限和支持会话，
它们尚不能直接登录 Octop 运维后台。

当前客户端架构与有效约束见 [客户端说明](wanx-client.md)；早期电脑端方案保留在 Git 历史中。
