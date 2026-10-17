# 万象AI浏览器的 WANX 集成

本实现将此前仅在应用仓库提供的兼容补丁纳入 WANX 源码。适配基线为 WANX `f78be47`，应用验收版本为 `centuarai-wanx-ai-browser` 的 `1066bb5`（应用标识 `centaurai.wanx.ai-browser`）。

## 部署

更新本分支的后端与 `wanx-client` Host 后正常重启对应进程。应用代码与本分支配套使用；不再将旧 `local-current-20261015` 补丁叠加到本分支。本变更无需数据库迁移，不包含账号、模型密钥或用户浏览器资料。

登录后请求 `GET /api/browser/control-capabilities`，应返回 `version: 1`、`exclusive_control: true`、`keyboard: true`、`header_auth: true`、`skill_learning: 1`。接口需要浏览器权限；无权限返回 403，未登录返回 401，不能以静态占位响应代替本实现。

## 行为

- Host 两层网关放行浏览器 WebSocket，凭据通过请求头传递；旧工作台查询参数连接兼容。
- 浏览器资料与控制权按用户隔离。应用先取得人工控制；AI 控制必须绑定用户有权访问的专家和自己拥有的对话。
- 人工接管先阻止后续工具，再取消 AI 执行并等待正在执行的操作停止；等待时返回 pending。客户端确认完成后才开放人工输入。重新连接只恢复画面。
- 模型授权保持原有管理员限制，选择当前已启用的 DeepSeek，并写入该对话的原生 composer model。当前 WANX 主线使用原生模型工厂，无需本机特有的 credits/runtime 模块、单独模型工厂或新增任务预算。
- 技能学习观察当前标签页，45 秒租约由客户端续期；窗口断开或到期会停止录制并保留草稿。录制避免保存敏感输入与截图，整理多行正文和最终字段值，忽略隐藏同步字段。
- 保存、启用和删除技能继续使用既有专家 skills 接口。重复执行走正常模型对话与同一浏览器仲裁，不直接运行录制脚本。旧技能不会被自动重写。

## 验证

```sh
make all
cd wanx-client && npm ci && npm test
```

接口集成测试覆盖能力声明、鉴权、浏览器权限、原生模型选择、线程归属与接管等待；Host 测试使用真实两层网关，检查首帧保留、请求头认证与宿主连接失效。浏览器专项覆盖租约、技能用户隔离、富文本整理、键盘操作及排队工具阻断。

`wanx-client/tools/verify-browser-app.mjs` 提供真实模型验收：由测试环境设置 `WANX_BROWSER_ACCEPTANCE_ISOLATED=1`、`WANX_BROWSER_ACCEPTANCE_URL`（仅回环地址）、`WANX_BROWSER_ACCEPTANCE_TOKEN`、`WANX_BROWSER_APP_SOURCE`、`WANX_BROWSER_ACCEPTANCE_REPORT` 后运行。只用于独立测试服务器、账号、全新浏览器资料，禁止指向正在使用的用户服务。脚本连接两层 Host，执行手动示范→保存→新值复用→执行中人工接管→验证无后续 AI 点击→删除测试技能；报告仅包含状态与检查结果。

2026-10-17 已在隔离 WANX 服务及全新浏览器资料中用本机现有 DeepSeek 完成上述流程：3 步、1 个参数，页面提交的新值精确匹配，接管等待正在执行的操作停止，恢复人工输入，未出现后续 AI 点击，测试技能删除成功。富文本独立浏览器两轮验证通过。此验收未重启或操作用户正在使用的 WANX 服务及浏览器，也不等于已合入主线或正式发行。

本次完整检查：`make all`（Ruff、格式、mypy 590 文件、4492 项后端测试通过、17 项跳过）；客户端全量 946 项通过、9 项跳过；应用 34 项通过及语法检查。提交钩子另执行 Dashboard 构建。
