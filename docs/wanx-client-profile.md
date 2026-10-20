# 客户端个人资料与快捷面板

右上角头像菜单提供个人资料、设置和退出登录；个人资料支持头像上传、昵称编辑及脱敏手机号展示。快捷面板展示盒子状态、积分入口与应用列表；点击积分卡片进入积分页。

## 个人资料

头像与昵称按万象账号 `accountId` 保存在本机 `account.enc` 的 `profiles`，沿用 `safeStorage` 和串行原子写入，不上传或跨电脑同步，也不与盒端管理员账号混用。退出后隐藏资料，同账号重新登录恢复；切号隔离数据，晚到的选择或保存操作不能写入新账号。

昵称最多 40 个 Unicode 字符，拒绝空白和控制字符。头像支持不超过 5 MB 的 JPG/PNG，由主进程文件选择器提供路径，校验后居中裁剪为 256×256 PNG。渲染进程不能指定任意文件路径。保存失败不显示已保存状态。

## 积分入口

积分由 Admin 管理，客户端展示余额和购买弹框，支持支付宝与微信 Native、同订单恢复及支付/到账状态。客户端流程见[客户端积分接入](credits.md)，不在本页维护另一份契约。

## 构建与回退

```sh
npm ci --prefix wanx-client
npm test --prefix wanx-client
npm run start:client
```

界面回退不清理 `account.enc`；旧客户端可忽略 `profiles`。支付服务回退按[运维说明](../../nexusaos-admin/admin-backend/deploy/README-credits-payment.md)保留旧单履约责任。
