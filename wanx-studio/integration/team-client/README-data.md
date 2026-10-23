# 团队数据与 AI 对话集成

当前实现入口：`data-service.mjs`（可信主进程）、`data-view.js` / `data.css`（现有客户端内的数据页）、`starlink-launch.mjs`（启动确认）、`starlink-target.mjs`（星图接收）、`ai-dialogue.mjs`（团队账号偏好适配）。

数据页标题为「数据星图」，顶部 Tab 为「星图」，使用数据仓侧栏、核心图谱与证据栏组成紧凑工作台。`starlink/graph.mjs` 是 2026-10-23 从星图 `desktop/ui/graph.js` 原样保存的展示算法；保持实体、关系与来源数据不变。`data-view.js` 通过 esbuild 打包为普通浏览器脚本，客户端与离线原型共用同一份实现。

更新已安装客户端的数据界面时，运行 `node tools/stage-team-graph-client.mjs <输出名称>`，核对 `verification/<输出名称>/stage.json`；退出客户端后运行 `node tools/install-team-graph-client.mjs <输出名称>`。省略名称时使用 team-graph-20261023。安装器校验当前归档散列、保留同卷备份，只合入数据界面及其私有 IPC，保留其他客户端文件。完整集成构建仍使用原来的 stage-team-data-client 流程。

「分享接口」使用 `data-share-view.js` 和可信主进程的 `data-share-service.mjs`，沿用现有 runtime、仓 Key 与公开读取接口。新分享固定授权 documents/evidence/graph/search，不包含 reasoning。创建回执只向渲染进程交付临时句柄；复制 Key 由主进程完成，明确点击显示时才临时交付完整值。窗口关闭、账号变化或权限失效后清理句柄，Key 本身沿用星图的到期与撤销规则。未向真实用户仓自动创建任何凭证。

星图首页优先展示核心知识图谱，MCP 地址和复制入口位于页底。进入具体数据仓后，才能在「仓库访问 Key」中生成该仓的只读凭证，查看前缀、范围和有效期；生成窗口明确显示仓库名称，MCP 配置位于窗口下方。首页不提供 Key 生成操作，切仓或切账号后不复用旧仓的 Key 摘要。

`overlay/` 保存已安装客户端的共享文件改动，基于 `manifest.json` 中记录的原始 app.asar 散列。不要整文件覆盖其他版本；升级时应逐项合并这些文件，保留正在进行的个人版与团队版工作。独立素材和许可保存在 `assets/`。

星图的权威源码位于 `/Volumes/OneDrive/OneDrive/AI/centaurAI/万象app/centuarai-semantica`。共享仓实现保留真实 `actor_id`，通过私有签名 `resource_owner` 区分团队与个人；已有个人仓不迁移。

WANX bridge 和应用授权适配位于星图仓库的 `integration/wanx/octop/infra/semantica`，安装器会同时补齐原有应用部署处理。团队管理员通过现有仓 Key 接口发出凭证，WANX 在内部保存；现有部署 configuration 只传 `keyId`，保存后只含服务端引用。`knowledge.*` 是已有 runtime invoke 的新增只读能力，不在发布包中存放 Key。

本机服务：8089 为现有 WANX，8090 为星图，18089 为原有模型私有回调地址；均保持 loopback。沿用原有 semantica.json 和星图 .env 身份、数据与模型配置。`local-starlink.py` 不修改模型配置。

图谱发布还依赖已有 Neo4j。本机使用 loopback 18687／18674，凭据和数据沿用星图原配置。`tools/prepare-local-starlink-graph-service.py` 为现有 Neo4j/JRE 生成独立 launchd 配置，交由 `ai.centaurai.wanx.starlink.graph.local` 保持运行，不初始化或重置数据库。只启动星图 HTTP 服务不能替代图数据库就绪。

正文解析、知识抽取和图谱写入是三个阶段。客户端对已有材料的空图谱提供处理任务入口，区分正文状态；任务中心可批量重试失败的图谱写入，复用已通过校验的抽取结果，不重复调用模型。存在活动任务时自动刷新，切换账号或失去权限时停止旧请求和刷新计划。

失败的原任务重试保留当时模型快照；「用当前模型补处理」只针对每份材料最新的失败抽取，展示服务端 effective 配置和材料范围后创建新任务，并提交同一配置签名与正文版本。模型切换、材料版本变化或权限失效均由现有服务端接口拒绝；不更改原任务记录或公开 API。

验证与限制见 `docs/wanx-team-data-implementation.md` 和 `verification/team-data-20261022`。验证凭据与运行数据仅保存在忽略的 `.runtime` 中；不要打包或提交它们。

2026-10-23 最新接入决定：空间与星图使用两个独立 MCP。设置中展示「空间 MCP」与 `/mcp/space`，星图首页底部展示 `/mcp/starlink`，具体仓库页面管理该仓 Key。分别使用 wanx-space / xingtu 配置与资源 Key，交叉 Key 被拒绝，旧统一 /mcp 返回 410。传输实现仍位于 wanx-mcp.mjs / wanx-mcp-bridge.mjs / wanx-mcp-knowledge.mjs，私有 IPC 分别读取对应地址。完整边界与验证见 docs/wanx-mcp.md。
