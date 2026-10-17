# 空间 Agent 访问链接

## 使用

在空间中右键一个文件或文件夹，选择“创建 Agent 访问链接”。默认长期有效，也可选择 1、7、30 天；复制后交给本机 Agent。工具栏的“Agent 访问链接”可查看、复制、撤销和检查最近操作。

链接只在生成它的电脑上可用。客户端必须运行、登录原账号并连接原盒子。切换盒子会暂停旧链接的访问，切回原盒子后可用；不会把同一链接指向另一个盒子。文件仍保存在盒端，没有公网分享入口。

文件链接允许读、改、重命名和移入回收站；文件夹链接包括当前后代和之后创建的文件。范围外移动、永久删除不向链接开放。文件移出授权目录后立即失去访问权；授权根进入回收站后整个链接不可用，恢复根需要空间界面。

持有链接的本机程序可读写指定资源。不要将它发给不受信任的程序。万象应用的原有同账号空间访问规则保持不变。

## HTTP 与 MCP

HTTP GET 链接返回 JSON 说明，含完整操作参数。GET 只允许 describe/stat/list/read/write-status；POST application/json 执行操作。正文上限 6 MiB；分块解码后最大 4 MiB。内容通过 read 分块返回，附分块 SHA256、完整 SHA256 和版本。目录按 offset/length 分页，最大 200 项。

覆盖文件：
1. stat 取得 version。
2. begin-write 传文件 ID、expected version、全新 32 位十六进制 upload_id、字节大小。
3. write-chunk 传 offset、base64 data、分块 digest；write-status 查询续传偏移。
4. commit-write 传完整 SHA256。成功后文件 ID 保持不变。
5. 失败可 cancel-write；并发版本变化返回 SPACE_VERSION_CONFLICT，重新读取后决定如何处理，不自动覆盖。
新建文件使用文件夹作为 target，并传 name。同名新建继续沿用保留两份的语义。

MCP：在链接管理中复制“MCP 接入配置”。客户端附带 shell/space-links-mcp.mjs，使用 stdio，兼容 2025-11-25 MCP 初始化协议。提供 space（完整分块操作）、space_read_text、space_write_text（文本快捷工具最多 1 MiB）。每次都必须显式给出用户提供的链接。配置通过 Electron 自带 Node 执行，不要求用户另装 Node；源码调试也可用 Node >=22 执行该脚本。

## 服务与数据

- 盒端 /api/personal-space/agent-links 管理链接；/agent-access 接受已登录账号及 X-Space-Link 凭证。只有链接没有账号会话不能直接访问盒端。
- 本机 HTTP 仅监听 127.0.0.1，验证 Host/Origin，不开放跨域 CORS，不接受调用者指定盒端地址或账号。
- 客户端账户、盒子、平台地址、两端凭证和持久化端口存于现有 OS 加密存储 space-links.enc。端口冲突明确报错，不更换旧链接。
- 盒端凭证仅存 SHA256。授权和操作在同一 SQLite 写事务内校验；每个请求使用独立服务实例。分块提交再次校验授权、目录归属和版本。
- 盒端继续使用每用户 .wanx-personal-space/<user>/index.sqlite3。新增本地索引列和链接/审计表，不涉及主业务 PostgreSQL/SQLite 的全局迁移编号。
- 更新以新的不可变 blob 配合索引指针原子发布，保留上一版，过时版本在发布后回收；空间占用包含上一版。版本恢复会交换当前与上一版。回滚客户端代码后，不应回滚盒端到不认识 blob 指针的旧实现。
- 记录时间、链接 ID、动作、目标、结果及自行声明的 Agent 名称；不记录文件内容和凭证。保留最近 10,000 条，全局上限；管理接口返回该链接最近 100 条。
- 撤销会取消尚未发布的关联上传。请求提交前发生注销/断线会拒绝后续请求，已经在线性化提交点完成的写入不会被客户端断线倒退。
- GET “read”只提供字节。文本快捷工具仅解码有效 UTF-8；不会自动解析 PDF/Office 或执行文件中的指令。

## 验证与交付依赖

功能分三笔：盒端授权与版本更新 → 客户端 HTTP 桥接 → MCP 与空间界面。三笔按顺序部署；界面和 MCP 需要前两笔。仅提交功能分支，不合并主线。

运行：
- UV_NO_SYNC=1 PYTHONPATH=src uv run pytest tests/unit/test_space_links.py tests/unit/api/test_space_links_api.py tests/unit/test_personal_space.py tests/unit/api/test_personal_space_api.py
- node --test --test-concurrency=1 tests/*.test.mjs（在 wanx-client）
- WANX_SPACE_PYTHON=<Python 路径> PYTHONPATH=<仓库>/src node --test wanx-client/tests/space-links-http-seam.test.mjs
- make all PYTEST_JOBS=4

HTTP seam 使用真实 Python HTTP 服务、客户端网关和独立 stdio MCP 进程，但认证是隔离测试夹具。真实已注册本机盒子的验收单独记录，不把夹具等同部署或远程实体盒子实测。
