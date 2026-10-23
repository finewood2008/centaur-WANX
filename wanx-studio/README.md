# 万象 Builder 1.0.0

团队版管理员的构建组件。客户端只负责输入需求、AI 补全与确认、资源和 ACP 配置；完整 PRD 问答、受控开发、试用、改进和版本采用在本工作台完成。

## 开发与验证

```sh
npm ci
npm run dev
npm run check
```

`npm run dev` 是本机隔离界面环境。连接真实 WANX 时，由同一服务进程挂载 `backend/wanx_studio`，沿用当前账号、模型与空间；不会把背景仓库授权自动转成成品应用权限。

`npm run build` 与 `npm run package` 生成界面和受信运行时。`tools/assemble-client.mjs team` 将生成资源装配到团队客户端，所有输出均已忽略。源码、锁文件、测试与必要静态资源可提交；构建产物、资料、凭据与业务数据不提交。

产品与部署说明见 [WANX 1.0](../docs/wanx-1.0-release.md)。
