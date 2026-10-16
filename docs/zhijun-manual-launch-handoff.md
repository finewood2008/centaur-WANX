# 知君仅手动启动：CodeUp / GitHub 交付说明

日期：2026-10-16（北京时间）
分支：`codex/zhijun-manual-launch-20261016`
基线：CodeUp `origin/master`，`cff3d37`。

## 问题与修正后的行为

本机 WANX 联调入口曾注册两处知君自动启动逻辑：

1. `zhijun-source-dev.mjs` 订阅盒子连接状态，账号已登录且盒子 ready 时调用 `manager.launch()`。
2. `shell/main.mjs` 收到 Electron `second-instance` 事件时调用 `sourceDevelopment.open()`。

因此用户只想连接盒子，或重复打开万象，知君也会被拉起。修正后，连接状态订阅只更新状态；重复打开万象沿用已有窗口显示/聚焦逻辑；知君仅通过应用列表的「打开」动作启动。

## 实际修改范围

上述知君适配入口是本机集成层，未纳入当前 CodeUp master；主仓库的正常启动流程原本没有这两处自动启动。因此本分支提供可执行、可审查的迁移工具和精确补丁，而不把含个人绝对路径的整个本机运行目录上传，也不声称 master 曾自带这一问题。

- `wanx-client/tools/disable-zhijun-autostart.mjs`：识别这一版旧联调适配器，移除两处触发。默认只检查，显式 `--apply` 才写入；先备份两个代码文件，失败时恢复。重复执行不再修改；遇到陌生适配器拒绝写入。
- `docs/integration/disable-local-zhijun-autostart.patch`：同一修复的代码差异，供已有旧联调入口的分支集成。
- `wanx-client/tests/zhijun-manual-launch.test.mjs` 与 fixtures：运行旧行为和修正后的生命周期，覆盖启动、重连、重复启动、手动打开、清理、备份及幂等。

此迁移工具由集成人员运行，不加入应用日常启动、安装钩子或 npm 默认启动命令。普通客户端没有旧适配器时，无需迁移；本分支不新增知君专用启动链路。

## 如何接入已有联调版本

在本仓库根目录执行，将 `<client-dir>` 替换为实际在用的 `wanx-client` 目录：

```bash
# 只检查，不写文件
node wanx-client/tools/disable-zhijun-autostart.mjs --client-dir '<client-dir>'

# 应用已识别的修复，并保留本机代码备份
node wanx-client/tools/disable-zhijun-autostart.mjs --client-dir '<client-dir>' --apply
```

`changed: true, applied: false` 表示发现旧逻辑；`applied: true` 时结果同时返回备份位置。备份位于目标客户端内独立的 `.manual-launch-backup-*` 目录，只包含修改前的两个代码文件。它们可能仍含本机路径，请勿提交备份。

没有旧适配器时返回 `NO_DEVELOPMENT_ADAPTER`。已修复的适配器返回 `changed: false`。不支持的变体应由集成人员人工比对，不能强行替换整段入口。

若使用补丁，先在包含旧入口的集成仓库运行：

```bash
git apply --check docs/integration/disable-local-zhijun-autostart.patch
git apply docs/integration/disable-local-zhijun-autostart.patch
```

迁移工具与补丁二选一。master 缺少旧适配器时不要强行应用补丁。应用后重启桌面端以重新加载入口；无需重启盒子后台、修改密码、重置账户或迁移聊天数据。

## 验证

- 旧 fixture 可复现：ready 自动打开一次，`second-instance` 再打开一次。
- 修正后即使初始已连接或反复断开/重连，也没有自动 launch；显式应用管理器 launch 仍可用，退出时正常取消订阅。
- CLI 默认检查不写文件；应用前备份、连续执行幂等；陌生实现拒绝修改；正常客户端无需修改。
- 本机实际运行验证：重启指定万象入口并连接「本机万象」，桌面显示已连接；进程核对未出现托管知君。用户正在使用的页面和其他功能保留。
- 上一轮本机窗口及应用启动相关验证为 23 项通过；不把它当作本交付分支的完整测试。本交付分支验证：新增生命周期与现有单实例测试 7 项通过；客户端全量 889 项通过、8 项条件跳过。精确补丁在保存的修改前实际入口上通过 `git apply --check`；迁移工具检查本机已修复入口为 `changed: false`，检查本分支普通客户端为 `NO_DEVELOPMENT_ADAPTER`。

迁移工具输出已与本机实际生效的适配器逐字核对一致；本机后续新增的终端控制台等并行入口保持不变。

分支完整检查 `make all PYTEST_JOBS=4` 已通过：格式、Ruff、mypy 通过，后端 4,458 项通过、17 项条件跳过。测试使用本分支源码；临时文件放在独立验证目录。客户端全量测试使用与分支锁文件匹配的独立依赖环境，同版本 Electron 二进制复用本机已安装文件。

本机没有在此次修复后再次进行真实手动打开知君的 UI 验证；手动 launch 行为已由可执行回归覆盖。Windows 实机和正式安装包验收未在本次执行。

## 合并边界

CodeUp 为核心仓库，GitHub 同名分支镜像同一提交。此交付只取消本机联调中的自动启动，不混入积分、浏览器、个人空间、其他应用或并行开发改动，不合并 master/main。知君应用本身未修改，不需要向其独立仓库提交空变更。

提交不包含本机账号密码、聊天内容、用户文件、运行配置或安装包。取消积分预算与本次取消自动启动是两项独立修复。
