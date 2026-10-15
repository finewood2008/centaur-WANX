# 取消任务预算：CodeUp / GitHub 交付说明

日期：2026-10-15
分支：`codex/remove-task-budgets-20261015`
WANX 基线：CodeUp `origin/master`，`11b613db92c528b257022afeb9dc1c71a87f663e`。

## 产品决定与实际行为

用户取消整套任务预算方案，因为报价、授权、追加及强制暂停影响应用正常使用。本分支固化取消后的状态：

- 应用沿用已有模型连接；不要求报价、预算授权、执行令牌或钱包余额才能调用。
- 移除任务上限、超限暂停、追加预算、自动任务单次/每日积分授权与对应客户端入口。
- 旧 `WANX_MODEL_GATEWAY_URL` 不改变调用路由；客户端不读取旧 `model-gateway.json`。
- 统一积分余额、历史流水、账号隔离及被动用量记录保留。用量试算按实际核实成本计算，不截断到旧任务上限。
- 用量统计不可用不阻止正常调用；未知用量/价格保留待核对，不伪造零成本。
- 真实支付、自动赠送及应用自动扣款没有启用。人工账本管理接口仍有原有权限校验，不等于上线支付。
- 工具执行审批、账号权限、私人资料隔离、任务试运行与显式启用保留；它们不是积分预算。

## 为什么 diff 包含积分基础代码

截至本次整理，CodeUp master 尚未包含本机正在运行的积分账本、用量记录及实验预算网关。不能针对未提交文件执行 Git revert；仅提交“删除预算文件”会遗漏应用运行所需的基础代码。

本分支从 CodeUp master 单独整理出可运行的取消预算版本，因此包含账本/试算基础代码、客户端只读积分页及其所需本机盒子连接能力。没有把实验预算网关提交后再恢复，也没有加入真实支付。其他并行开发的角色本体、交互偏好、浏览器新执行层、半人马环及众见完整功能代码均未混入。

知君另有同名分支，基于其 CodeUp master `fca39e8`。该远程基线本来没有实验预算代码，所以知君提交以直接聊天/旧预算事件回归测试和实验版本迁移补丁为主，不冒称远程线上已部署过预算功能。

## 数据库兼容

迁移 024 为账号账本，028 为用量；029/030 的历史网关与授权表保留，只用于旧开发数据库兼容及审计，没有活动网关与授权路由。

同时保留已分配的 025/026/027 表结构，避免 schema version 升至 030 后将并行应用迁移永久跳过。这仅是兼容表结构，不表示该分支已交付半人马环或众见应用。合并其他功能分支时核对这些 SQL 文件；不可重复分配编号、删表、重置历史积分或补扣历史用量。

## 并行开发分支如何接入

本机已集成的应用完成了预算取消，但其完整新功能尚未在本 WANX master 上合并。为避免混入其他功能，本分支提供精确适配补丁：

- `docs/integration/remove-loop-budget.patch`：移除半人马环 automatic_scope 和云预算失败暂停，保留 task_scope 被动记录与原有人工审核。
- `docs/integration/remove-dialogue-budget.patch`：众见模型池恢复直接模型调用与被动成本回调。
- `docs/integration/browser-meter-compat.patch`：仅在已经合入浏览器 model_access 模块的分支应用，保留该模块独立的直接模型执行路径，不恢复预算路由。

补丁针对本机实验实现；先在相应功能分支运行 `git apply --check`，通过再应用。master 不存在上述应用文件时不要强行应用。已取消预算的分支也不要重复应用。浏览器兼容补丁应在合并其独立功能时一并审查。

众见服务的任务归集还须将旧 `meter.quote(..., audit_unregistered=True)` 改成 `meter.create_task(...)`，移除 audit_unregistered 参数，并对 create/start/finish 的统计故障记录警告后继续业务。不要恢复授权步骤。对应示例差异见 `docs/integration/dialogue-task-recording.patch`。

集成过旧网关的实验分支应删除以下活动模块及其专用测试，不能仅隐藏按钮：

- `src/octop/infra/credits/cloud_client.py`、`cloud_gateway.py`、`scheduling.py`
- `src/octop/api/cloud_gateway.py`、`src/octop/cloud_gateway.py`、`src/octop/infra/db/repos/cloud_gateway.py`
- `wanx-client/account/cloud-tasks.mjs`、`gateway-controls.mjs`
- `tests/integration/test_cloud_gateway.py`、`tests/unit/test_cloud_client.py`
- `wanx-client/tests/cloud-tasks.test.mjs`、`gateway-controls.test.mjs`
- `docs/wanx-cloud-gateway.example.json`

移除相应导入、provider 强制改写、chat 请求的 billing_task_id / gateway_task_id / gateway_execution_token、暂停/追加消息处理与预留授权接口。此交付分支的活动代码已无这些依赖。

## 本机升级注意

停止旧预算网关进程，移走其自启动项和客户端 model-gateway.json；保留私有备份，勿上传密钥。恢复原有模型配置，不复制用户的运行目录或数据库到源码仓库。数据库只正常前向迁移，不回滚表。

客户端与应用需一起更新并重启，以免旧页面继续请求退休接口。部署后验证：零余额可以正常聊天；万象积分页展示预计用量；没有预算、追加或自动任务积分授权入口；真实余额没有变化；充值按钮禁用。

## 验证记录

在独立交付工作区验证，Python 导入路径明确指向本分支源码：

- `make all PYTEST_JOBS=4`：格式、Ruff、mypy 通过；4,492 项通过，17 项条件跳过。
- 积分接口、Consumer 读取及应用权限针对性验证：62 项通过。
- `npm --prefix wanx-client test`：739 项通过，6 项条件跳过。
- Dashboard `npm run build`：类型检查及构建通过，保留既有构建体积/动态导入提示。
- 知君同名分支 `ed94c62`：服务 117 项、UI 88 项、桌面 22 项通过，构建通过。
- 半人马环、众见模型池、知君实验版退休补丁在保存的实验源码上通过 `git apply --check`；浏览器兼容补丁在本分支通过应用检查。众见任务归集补丁为旧实现适配示例，需结合对应功能分支检查上下文。

验证覆盖零余额/无预算调用、超过旧上限仍完整记录、统计故障不阻断、旧授权接口退休、账号与应用隔离、历史账本事务及充值禁用。首次整理遗漏的账本访问规则与旧 schema 版本断言已补齐；临时测试磁盘写满后改用独立测试目录完整重跑，以上为最终结果。

此前本机含并行功能的运行验证另见 [用量记录说明](wanx-token-pricing.md)，不能将两套结果混为一谈。

Windows 实机、外部盒子、生产发布、生产账单核对不属于本次分支提交验收。60%–70% 毛利仍是设计目标，不能以试算结果宣称实际实现。

## 合并与同步

CodeUp 是核心仓库，GitHub 同名分支只镜像完全相同的提交；不覆盖 main/master，不自动合并。集成人员先审阅代码、迁移和上述并行功能补丁，再按项目流程合并。

本提交不包含本机凭据、账户数据、聊天内容、构建包或运行配置，不启动支付、不向真实账号加点或补扣。
