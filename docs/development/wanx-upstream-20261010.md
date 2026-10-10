# WANX 上游合并记录 · 2026-10-10

## 来源与范围

- 官方仓库：https://github.com/TencentCloud/Octop
- 主分支快照：`0c5a46ab5f82e5ad9d1a56fa09b00e542f042fda`（版本 `1.0.2b6`）。
- 共同基础：`232030f46c5450801ca87809f8a4da57aefc5a05`（`1.0.2b4`）。
- 本地原工程：`/Users/finewood/Documents/ChatGPT/octop项目`，原 HEAD `7d84a9973a2e18b7083d4b21d68fe6332123765c`，包含原有未提交改动。
- 隔离合并目录：`/Users/finewood/Documents/ChatGPT/wanx-octop-update-20261010`，分支 `codex/wanx-upstream-20261010`。
- 按共同基础三方合入官方增量，保留 WANX 自定义代码；结果同步为本地工作区改动，不改写历史，不推送远端。

## 合并处理

上游新增远程实例 Bridge、LDAP、Agently CLI 连接器、技能复制策略，以及对话、存储、浏览器和打包修复。

保留 WANX 品牌界面、盒子 SDK 管理、桌面连接层、独立记忆入口、个人画像与应用隔离。保留 WANX README，官方说明更新到 `README.upstream.md`。共享令牌实现移至上游 `infra/auth/tokens.py` 后继续签入 `application_id`；远程专家 ID 在应用边界中校验 WANX 身份和连接所有权。

### 数据库编号映射

| 官方 Octop | WANX 合并后 | 原因 |
|---|---|---|
| 019_bridge_connections | 024_bridge_connections | WANX 019 已部署自我模型表 |
| 020_skill_copy_policy | 025_skill_copy_policy | WANX 020–023 已部署应用隔离与产品档案 |

SQLite/PostgreSQL 成对保留，既有 019–023 不重编号。后续合并以本记录的上游 SHA 为已导入快照，并继续维护以上编号映射；本次没有创建上游祖先合并提交，不能仅凭原 HEAD 的 merge-base 重放全部变更。

## 验证

- 后端 `make all PYTEST_JOBS=4`：通过。Ruff、mypy（616 个源文件）通过；pytest **4882 通过、18 跳过**，17 个依赖弃用警告，耗时 327.04 秒。
- 前端 `npm run build`：通过（TypeScript + Vite）；Python wheel 构建通过，确认包含网页、盒子 SDK host、新迁移与 Bridge 模块。
- SDK 管理 `npm test`：4 通过；私有 SDK 包 SHA-256 保持 `c7f0bf3a2a2ab3b466a10fc56097fa2bbac44d44dc7aa35736554d206a6249ed`。
- 应用边界和升级专项：65 通过；首次全量发现的后端问题修复后专项 23 通过、1 个 Linux 专用用例在 macOS 跳过。
- 前端全量（Node 25 下设置 `NODE_OPTIONS=--no-experimental-webstorage`）：1177 通过、6 失败，另有 3 个套件因 jsdom 缺少 `DOMMatrix` 无法加载。所有残留失败在未合并的 GitHub 快照中复现；没有将失败计为通过。
- 前端既有失败：`AuthGuard.test.tsx` 1 项、`publishedExperts.test.ts` 1 项、`useSessions.test.ts` 4 项（含缺失 mock 导出）；`DocumentPreviewCore.docxSanitize`、`skillMarkdown`、`SkillDrawer` 3 套件加载错误。新增的知识库 Bridge 请求头测试已适配并通过。知识库、手机流、盒子连接专项共 12 通过。
- 前端 ESLint 仍有 2 个原有错误和 68 个警告：未使用的 `DEFAULT_CHANNEL_DISPLAY_CONFIG` 测试导入、`chatStore.ts` 中冗余 `Boolean`。未把本次合并扩大为这些既有代码的清理。
- 当前真实数据库的只读备份副本重复升级：23 → 25；40 张原有表按原字段逐行摘要比较完全一致；完整性检查 `ok`、外键违规 0。真实数据库未写入。
- 独立端口 18088、新建测试账号：健康、网页、登录、用户信息、远程连接列表、专家、知识库、API 文档、盒子 SDK 状态全部成功；匿名访问账号接口返回 401。OpenAPI 中新增 Bridge/盒子接口都有摘要，浏览器确认 WANX 登录页正常显示。
- 未进行真实模型调用、真实盒子 P2P、LDAP 目录或 PostgreSQL 实库联调；Linux/Windows CI 尚未运行。

## 运行与回退

本次修改源码及本地构建产物。运行中的 `~/.octop/portable` 服务没有切换版本，真实数据库未迁移，现有局域网 `0.0.0.0:8088` 配置保持原值。

源码变更前备份及逐文件哈希清单位于 `/Users/finewood/Documents/ChatGPT/wanx-upstream-backup-20261010`。`source-before.tar.gz` 保存被覆盖文件，`source-manifest.json` 记录新增/删除路径及前后校验值，回退时只处理这些路径并先检查后续编辑。数据库演练副本含本机数据，仅保存在该目录，不进入仓库。

## GitHub 同步

本次上传以 GitHub WANX 提交 `3e0034ce2122e2e4bb1055b87cfed302c42ec71b` 为父提交，导入已验证的上游合并结果；保留 WANX 历史。2026-10-10 上传前重新查询官方主分支，仍为 `0c5a46ab5f82e5ad9d1a56fa09b00e542f042fda`。仓库已按所有者要求改为私有。

这是源码同步。上游的合并后自动打标签发布仅在 TencentCloud/Octop 官方仓库启用，避免本仓库合并代码时自动发布 PyPI、镜像和安装包；显式的发布工作流保留。当前运行实例与数据库不在本次部署范围内。

### 上传前补充修复

- Bridge 登录禁止自动跟随重定向，避免向重定向地址转发凭据；成功直连登录行为保留。
- 收到远程对话后异步执行，使 WebSocket 可以继续接收其他请求和回复；断开、注销或替换连接时取消旧对话任务。
- 上述行为增加 6 项回归测试；Bridge 与飞牛部署专项共 107 项通过。飞牛镜像版本与项目 1.0.2b6 对齐。
- `make build-frontend` 先安装盒子管理模块的锁定依赖，完整执行已通过。npm 保留本地 SDK 的 `file:` 地址；CodeQL 补齐私有仓库读取代码和工作流记录的权限。
- 本地提交检查钩子保持启用；GitHub CI 固定使用 4 个测试 worker，并保留超时诊断。
- 最终源码重新执行 `make all PYTEST_JOBS=4`：4888 通过、18 跳过、17 个依赖弃用警告，296.21 秒；Ruff 和 mypy 同样通过。
