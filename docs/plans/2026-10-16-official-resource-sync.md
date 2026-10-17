# 官方专家与技能包同步实施计划

状态：代码实现及本地联调完成（2026-10-16），尚未部署。本轮不向线上客户自动发布资源。

## 范围与验收

1. Admin 可浏览 Octop 官方 Git 专家及 SkillHub 专家、技能包，按资源订阅、暂停和立即检查。默认每 6 小时检查已启用订阅。
2. 上游完整内容不变时不新增版本；变化时创建不可变草稿并记录上游来源、修订和内容摘要。失败、删除、部分下载不能改变已发布版本。
3. 专家和技能包支持指定多个客户灰度；未入名单的客户与旧 Bridge 仍只解析正式资源。转正式使用相同包和签名，不重新打包。
4. 灰度限制资源获取与应用准备；停止灰度不删除已创建专家或客户数据。应用运行授权仍由应用灰度与账号权限负责。
5. Bridge 定时更新资源目录，应用准备时按需下载完整依赖；缓存命中也必须遵守当前账号的资源准入。旧正式资源保持兼容。
6. 不修改 `src/octop/`；经现有公开 API 创建资源，已有专家实例不自动覆盖。

## 工作分解与文件责任

- Admin 官方来源适配器：新增独立 provider 模块与测试，负责受限网络获取、完整包转换和内容摘要。
- Admin 订阅流水线：新增订阅模型、SQL、服务、路由、独立定时 worker 与测试；复用现有草稿注册接口。
- Admin 资源灰度：资源目录服务、控制器、签名合同、灰度模型/SQL与测试；与应用灰度依赖检查衔接。
- Admin 前端：资源页面、来源订阅组件、资源灰度操作、API与测试；复用客户多选组件。
- Bridge：资源合同、目录、下载和准备流程及测试；不改 Octop 核心。
- 主任务：共享接口协调、服务器路由接入、文档、跨端验证及最终审查。

## 接口约定

来源订阅放在 `/nexus/resource-upstreams`，来源枚举 `octop-git`、`skillhub-expert`、`skillhub-skill`。
`GET /catalog?provider=&query=&page=&limit=`；`GET /subscriptions`；`POST /subscriptions`（provider、upstreamId）；
`PATCH /subscriptions/{id}`（enabled）；`POST /subscriptions/{id}/sync`（排队立即检查）。
目录项包含 upstreamId、name、description、kind、revision；订阅项含 id、provider、upstreamId、kind、resourceId、enabled、status、lastCheckedAt、nextCheckAt、lastVersion、lastError。

资源灰度在现有资源版本路径下增加 `POST /gray`（accountIds）、`POST /gray/stop`（空对象）。
灰度行使用 `status=gray`；首次签名的 payload 额外包含 `releaseAccess: account`，并沿用该签名转正式。
旧版严格校验器不能接受这个新增字段。新 Bridge 请求使用 `resourceProtocol: 2`；旧版请求不会收到受控资源。
设备 `resolve`、`download` 对受控资源使用服务端已验证的 accountId 与设备权限，灰度包本地缓存不绕过准入。
资源停止灰度后返回草稿，保留 immutable envelope；是否可转正式仍需要完整依赖检查。

## 验证顺序

1. 单元与数据库集成：来源内容去重、并发/重试、暂停、失败隔离、完整依赖、不可变版本。
2. 灰度正反例：名单内外、设备越权、缓存命中、旧协议、转正式摘要/签名相同、缺 SQL 时旧稳定接口。
3. Bridge：目录不下载全市场、按需获取、现有实例和数据保留、依赖缺失失败可恢复。
4. Vue 交互测试和生产构建；对齐实际 API 返回结构。
5. 跨端签名包与真实上游只读抽样；不自动发布生产、不冒充实机部署验证。

## 依赖与部署

需要新增 SQL、独立订阅 worker 的定时配置，以及已有资源 OSS/签名配置。先升级 Admin 和 Bridge，再对新资源开启灰度；原有正式资源与应用保持可用。

## 进度

- [x] 核对现有资源注册、发布、下载、账号授权和 Bridge 安装边界。
- [x] 明确接口、旧协议隔离和不覆盖客户实例的验收边界。
- [x] 各模块实现与模块测试。
- [x] 跨端验收、文档和回归检查。

## 最终验证记录

- Admin 资源、应用市场、官方来源及跨端回归：343 项通过。
- Bridge 完整测试：352 项通过，含真实 Octop 公共 API 安装和同盒账号隔离；没有修改 `src/octop/`。
- Admin 资源及应用市场前端相关测试：69 项通过，生产构建通过。
- 真实上游只读抽样：Octop `ai-coding-coach`、SkillHub `python` 与 `tech-test-automation` 完整获取成功；没有上传或发布到线上。
- 补充边界：同账号不可同时进入同资源的两个灰度版本；上游 A→B→A 回退生成新递增草稿；已正式资源撤回仍允许原实例安装后访问。
- 尚未完成的上线验收：生产 MySQL SQL 执行、OSS/worker 配置、盒端更新及真实客户应用验证。本轮未做生产变更，也未进行实际浏览器视觉验收。

Admin 部署与操作手册：`nexusaos-admin/docs/operations/resource-upstream-sync.md`。
