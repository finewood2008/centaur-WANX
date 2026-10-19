# MCP 子目录创建与回收站恢复修复

## 问题与行为

Codex 实际调用暴露两处问题：`mkdir` 传 `parent` 时忽略目标目录而在授权根目录创建；删除只返回 `ok`，同时 `stat` 拒绝查询回收站项目，Agent 无法取得恢复所需的最新版本。

- `mkdir` 接受 `target` 或 `parent` 指定父目录；两者同时提供时必须相同，否则返回 `SPACE_INVALID_DESTINATION`，不会创建目录。旧调用省略目标时继续使用授权根目录。
- `trash` 保留 `ok`，并返回删除后的公开元数据，包括资源 ID、版本和回收站状态。Agent 可用此版本恢复，也可在新进程中对已知资源 ID 调用 `stat`，再用观察到的当前版本恢复。
- `stat` 仍校验接入状态、空间、额外授权和祖先关系，仅允许查询授权范围内已知回收站项目的公开元数据。回收站内容不可读取；授权根或祖先失效时仍拒绝访问。文件型链接的根被删除后，仍需由用户界面恢复。
- 恢复、移动和覆盖继续要求版本一致，不通过猜测版本或跳过校验解决问题。其他端改变资源后，旧版本恢复仍返回 `SPACE_VERSION_CONFLICT`。
- 补充 MCP 参数描述和 Agent 模式的初始化说明，明确目录目标、版本来源、回收站恢复流程和授权边界；复用原 HTTP/MCP 服务，不新增盒端接口。

## 依赖与交付

目标为 CodeUp `wanx`，本笔基于远端 `19270d9`，保留该分支的盒子资源统计和 Agent 弹窗改动。前置空间分层、存储迁移与导航链路为 `f18defc` → `62e5a16` → `0d118e1`，已包含在该基线中。本次将两项修复、对应回归与此说明整理为一笔提交；不合并 `master/main`。

需要配套更新盒端 `personal_space/links.py`、`personal_space/workspaces.py` 和客户端 `shell/space-links-mcp.mjs`。既有文件、链接、MCP 身份、存储位置及版本数据无需迁移。

## Codex 真实验收

使用真实 Codex CLI 0.162.1，通过已安装万象客户端的 stdio MCP、本机 HTTP 桥及当前本机盒端执行。不是仅使用协议探针或测试认证夹具。两个临时配置分别从界面审批为独立空白空间，软件自报名称相同但身份不同；未读取现有个人文件。

- 审批前拒绝文件访问；同配置重连和新 Codex 进程复用原空间。
- `project/archive/deep` 三级目录的 parent-only、target-only、两者一致均成功；冲突参数被拒绝，列表中没有错误的根目录副本。
- UTF-8 创建、读回、保留 ID 更新及 SHA-256 一致；旧版本覆盖被拒绝，原内容保持。
- 文件和空文件夹的删除、查询、按观察到的版本恢复均成功。新 Codex 进程查询回收站版本 5，再恢复为版本 6，无需猜测版本。
- 64 字节覆盖写入在 30 字节处中断：提前提交返回不完整，原有 33 字节内容及摘要保持；暂停接入后读取和提交被拒绝；恢复后新进程从 30 字节继续至 64 字节，提交保持原 ID、父目录及 33 字节上一版，无重复文件。
- 第二个身份不能查询、读取第一个身份的资源，不能向其目录创建子目录，也不能查询其上传任务；第一个身份暂停时，第二个身份自己的读写仍可用。
- 额外授权内的子目录、读写和删除恢复通过；省略授权 ID、撤销后的元数据/读取/尚未发布写入提交均被拒绝，自己的空间仍可用。
- 记录覆盖 87 次真实 MCP 调用、33 项独立结果断言；完整续传摘要为 `74b90cdceb59f16eecbe3ad8f035ae950463f79482c1fb4e181d0585af6ff47d`，另由盒端用户接口核对。

验收时基线为 `0d118e1` 加本笔修复；整合 `19270d9` 未改变这三个生产文件或对应修复测试。本机运行文件与被验收修复源码逐字节一致，安装版签名校验通过。原始记录和截图位于交付工作目录 `outputs/wanx-codex-mcp-fix-20261018/`。

## 自动验证

- 新增用例在修复前出现 4 项失败，覆盖两个缺陷；修复后相关 Python 服务/API 16 项通过。
- MCP 协议、真实 HTTP 网关和独立 stdio 进程回归 5 项通过，无跳过。
- 修复原基线的客户端全套 1057 项通过、10 项跳过；后端完整重跑 4724 项通过、17 项跳过。首遍有一项知君 0.2 秒定时提取测试因第二轮提取提前覆盖最近统计而失败；单项及完整重跑通过，未修改该模块，两次结果均保留。
- 整合 CodeUp `wanx` 的 `19270d9` 后，本轮 `UV_NO_SYNC=1 make all PYTEST_JOBS=2` 退出码 0：格式、Ruff、mypy 通过，Python 4741 项通过、17 项跳过，耗时 488.00 秒；客户端完整回归 1059 项通过、10 项跳过、0 失败。

可复跑命令（仓库根目录）：

```sh
UV_NO_SYNC=1 uv run pytest tests/unit/test_agent_spaces.py tests/unit/test_space_links.py tests/unit/api/test_space_links_api.py -q --no-cov
WANX_SPACE_PYTHON="$PWD/.venv/bin/python" PYTHONPATH="$PWD/src" node --test wanx-client/tests/space-links-mcp.test.mjs wanx-client/tests/space-links-http-seam.test.mjs wanx-client/tests/agent-spaces-http-seam.test.mjs
WANX_SPACE_PYTHON="$PWD/.venv/bin/python" PYTHONPATH="$PWD/src" node --test wanx-client/tests/*.test.mjs
UV_NO_SYNC=1 make all PYTEST_JOBS=2
```

提交继续使用仓库正常钩子执行 `make precommit`（格式、Ruff、mypy）及 dashboard 构建。

## 清理与验收边界

合成文件、目录、保留版本、额外授权目录和未完成上传已清理；样本条目、占用字节和未完成任务均为 0。两个测试接入断开，授权撤销，临时凭证配置目录删除；仅保留产品现有的空空间回收站记录、断开记录和审计。原有 18 个文件的 ID、父目录、版本和摘要，以及 9 个空间记录保持不变。前两遍全量测试及本轮提交前整合回归产生的临时目录均已清理。

本次真实链路验收限当前本机盒端；没有新增实体远程盒子、客户端账号切换或整机重启验收。Claude 尚未完成实测，已按用户要求安排在其可用后单独验收，不计入本笔已通过结果。
