# STARLINK 前端开发接入指引

核对日期：2026-10-20。适用代码：STARLINK `desktop/shell/service.mjs`、`preload.cjs`、`main.mjs`，WANX `wanx_bridge/semantica/`，独立 Semantica 的 integration 接口。

本文面向 STARLINK Electron 前端开发，覆盖当前 **47 个 service 动作、8 种推理操作**，另列打开万象模型管理的 IPC 动作。表格列出页面消费字段和关键约束，不是完整响应 Schema；未列字段应保留，不能以本文示例裁剪服务返回。测试样例不等同于真实业务数据。

## 1. 接入方式与职责

```text
STARLINK Renderer
  → window.semantica.call(action, input)
  → preload / Electron main / SemanticaService
  → WANX Host SDK（当前账号、当前盒子连接）
  → WANX bridge /api/semantica/*
  → Semantica standalone /api/integration/*
```

前端继续复用现有 preload 和 service；本次桥接改造不要求替换页面的动作名称。

| 层次 | 前端开发约定 |
|---|---|
| Renderer | 调用 `window.semantica.call()`，通过 `subscribe()` 接收事件；不直接连接 Semantica 地址 |
| Electron service | 转换参数名、构造路径、文件选择、分块上传、下载校验、Host 请求 |
| WANX Host / bridge | 复用登录和盒子会话，校验用户及 `knowledge_bases` 权限，生成资源上下文 |
| Semantica standalone | 处理材料、仓、Key、Skill、推理等业务，校验资源归属、版本及操作上下文 |

standalone 不要求前端配置服务密钥，也不要求两端同步服务签名密钥、box ID、application ID。前端不传 `workspace_id/workspace_ids`，不生成 `X-Semantica-Scope` 或身份头。`warehouseId` 是选择的仓 ID，不能当作 workspace ID。

Semantica 的 `/api/integration/*` 在此模式下只应对可信 WANX 后端可达。部署地址和网络边界由服务端配置，不能在页面增加“直连 Semantica”作为连接失败回退。

### 不同系统的接口来源

| 能力 | 实际来源 | 页面应使用的入口 |
|---|---|---|
| 当前账号、盒子名称、连接信息 | `host.context()` | `initialize` 的 `identity` |
| 空间文件浏览和读取 | `host.drive.overview/list/stat/read` | `space-list`、`select-space-files`；上传再进入 Semantica |
| 本地文件选择和保存 | Electron 对话框及文件系统 | `select-files`、`select-migration`、下载动作 |
| 本人图谱 | Semantica 集成层 owner view | `graph` → `W/owner/graph`，不替换成原生 `/graph/neighborhood` |
| 模型目录及模型调用 | 万象模型配置，经 Semantica 和 bridge 私有回调衔接 | `model-catalog`、模型设置动作；页面不调用私有回调 |
| 管理员原生接口 | `/api/semantica/native/*` → Semantica `/api/*` | 本文桌面功能不使用该入口 |
| 开放知识接口 | `/api/semantica/open/v1/*` | 见第 10 节；与页面管理动作区分 |

## 2. 前端调用、返回与事件

### 2.1 实际可用的 preload API

```ts
// 类型描述，不是要求另建 SDK；当前实现位于 desktop/shell/preload.cjs。
interface SemanticaBridge {
  call(action: string, input?: Record<string, unknown>): Promise<unknown>;
  subscribe(callback: (event: SemanticaEvent) => void): () => void;
}

type SemanticaEvent =
  | { type: "invalidated"; code: "HOST_SESSION_EXPIRED" }
  | {
      type: "upload"; handle: string; state: "uploading" | "received";
      offset: number; size: number; documentId?: string;
    }
  | { type: "migration-download"; offset: number; size: number };
```

`call()` 成功直接返回业务对象，失败抛出带 `code`、可选 `publicMessage` 的 Error。

| 边界 | 成功 | 失败 |
|---|---|---|
| bridge HTTP | JSON 业务对象本身，例如 `{items:[],total:0}` | 顶层 `{code,message?}` 和对应 HTTP 状态 |
| Electron main 内部 IPC | `{ok:true,value:业务对象}` | `{ok:false,code,message?}` |
| Renderer `window.semantica.call()` | 已解包的业务对象 | 抛出 Error；读取 `error.code`、`error.publicMessage` |

页面不能再次读取 `result.data` 或 `result.value`。HTTP 201/202 仍须返回 JSON；204 空响应、原始二进制不是当前 service 的成功契约。

### 2.2 按仓调用和过期响应保护

现有 `desktop/ui/app.js` 的 `call()` 已注入当前 `warehouseId` 并检查页面 generation。扩展页面应复用它；若重写前端，可采用以下等价模式：

```js
const state = { warehouseId: null, generation: 0, invalid: false };

async function call(action, input = {}) {
  if (!window.semantica) throw Object.assign(new Error(), { code: "WANX_HOST_REQUIRED" });
  if (state.invalid) throw Object.assign(new Error(), { code: "HOST_SESSION_EXPIRED" });
  const generation = state.generation;
  const result = await window.semantica.call(action, {
    ...input,
    warehouseId: state.warehouseId,
  });
  if (state.invalid) throw Object.assign(new Error(), { code: "HOST_SESSION_EXPIRED" });
  if (generation !== state.generation) {
    throw Object.assign(new Error(), { code: "WAREHOUSE_CHANGED" });
  }
  return result;
}

const unsubscribe = window.semantica?.subscribe(event => {
  if (event.type === "invalidated") {
    state.invalid = true;
    state.generation++;
    // 停止轮询，清空页面材料/图谱/Key/文件句柄/推理准备状态，禁用操作。
  }
  // upload：按 handle 更新进度；received 表示导入已提交，不代表抽取已完成。
  // migration-download：更新当前迁移包保存进度。
});
// 页面卸载时调用 unsubscribe?.()。
```

切仓时先递增 generation、更新仓 ID、清空当前仓视图，再调用 `select-warehouse`，然后加载新仓数据。`select-warehouse` 只通知 service 仓切换，不会替页面保存仓 ID；后续按仓动作仍需传 `warehouseId`。切仓期间返回的旧请求不得写入新仓页面。

## 3. 参数约定

- 下表 HTTP 路径均省略 `/api/semantica`；`W=/warehouses/{warehouseId}`。
- 标记 `W` 的动作，页面统一传当前 `warehouseId`。旧 service 为部分材料接口保留了无仓路径，但新页面不要依赖该回退；Skill 和推理动作强制要求仓 ID。
- 下表“页面输入”是传给 `call()` 的字段；HTTP body 的蛇形命名由 service 转换。
- `op` 表示 HTTP body 的 `operation_id`，对应页面 `operationId`。建议使用 `crypto.randomUUID()`；一个操作意图生成一次，重试同一请求保留，内容变化或新操作使用新值。
- 仓 ID 使用服务返回的 UUID；文档、任务、上传句柄等 ID 均视为不透明字符串，不自行拼造。
- `offset` 为从 0 开始的非负整数。当前 service 固定材料/任务每页 100、Skill 每页 20、检索结果 10；向这些动作额外传 `limit` 不会改变请求。
- 以下列表的 `items` 直接使用，勿假设所有列表都有 `total`，例如仓列表和 Key 列表没有统一分页包装。

### operationId 的具体行为

| 动作 | 当前 service 行为 |
|---|---|
| 建仓、建/撤 Key、清仓/删仓准备与执行、导出、保护设置、更正、重试任务、建索引 | 页面必须提供 `operationId` |
| Skill 导入/删除、`reasoning`、`reprocess-models` | 可传；省略时 service 自动生成。需要控制重试时应显式保留 |
| `upload`、`import-migration` | 文件选择时由 service 生成并随 handle 保存；页面重试同一 handle |
| `check-models`、`save-models` | service 每次调用重新生成，忽略页面 `operationId`；不要套用自动幂等重试，结果不确定时先重读配置 |
| `search` | 没有操作 ID；bridge 增加 `delivery_mode:"masked"` |

## 4. 完整动作映射

### 4.1 初始化、文件选择与 Host 能力（8 个）

| action | 页面输入 | HTTP / 执行来源 | 页面结果 |
|---|---|---|---|
| `initialize` | 无 | 并发 GET `/status`、`/capabilities`、`/warehouses`、`/warehouses/runtime`；Host context | `{identity,status,capabilities,retrieval:null,warehouses,runtime}` |
| `runtime` | 无 | GET `/warehouses/runtime` | `local_only,model,embedding,api_base_url,host_api_prefix` 等运行信息 |
| `select-warehouse` | 无；页面另行维护当前仓 | 本地 service；无 Semantica HTTP | `{selected:true}` |
| `space-list` | `parent?`，根目录 `""` | Host Drive | `{parent,breadcrumbs:[{id,name}],items:[{id,name,kind,size,digest,format,problem}]}` |
| `select-space-files` | `warehouseId,entries:[{id,digest}]` | Host Drive stat 校验；最多 200 项 | 文件描述数组，含 `handle,name,size,format,source:"space",spaceId` |
| `release-files` | `warehouseId,handles:[]` | 释放当前仓匹配的 service 文件句柄 | `{released:true}` |
| `select-files` | `warehouseId` | Electron 本地文件选择 | 文件描述数组，含 `handle,name,size,format,source:"computer"`；取消返回 `[]` |
| `select-migration` | 无 | Electron 选择 `.xingtu/.zip` 迁移包 | 文件描述数组；取消返回 `[]` |

`initialize.warehouses` 是 `{items:[...]}`，不是裸数组。`identity` 为：

```ts
type HostIdentity = {
  boxId: string;
  boxName: string;
  user: { id: unknown; name: string };
  connection: unknown; // Host 返回的连接信息，按 Host 契约使用
};
```

### 4.2 材料、任务、图谱与保护（13 个）

本组均传 `warehouseId`，表格仅列其余输入。

| action | 页面输入 | HTTP 请求 | 返回重点 |
|---|---|---|---|
| `documents` | `offset?` | GET `W/documents?limit=100&offset=…` | `{items,total}`；保留材料 `id,original_name,status,active_version_id` |
| `document` | `id,offset?` | GET `W/documents/{id}?segment_offset=…&segment_limit=100` | 详情结构见第 5 节 |
| `upload` | `handle` | POST/PATCH/commit `W/imports`，必要时 GET `W/operations/{op}` | `{document,job,reused}`；见第 6 节 |
| `download` | `id` | GET `W/documents/{id}`，再分块 GET `W/documents/{id}/blob` | 保存成功 `{saved:true}`；取消 `{canceled:true}` |
| `jobs` | `offset?` | GET `W/jobs?limit=100&offset=…` | `{items,total,limit,offset,activity}`；任务 `id,status` 等原样保留 |
| `retry-job` | `id,operationId` | POST `W/jobs/{id}/retry`，body `{op}` | job 对象；刷新任务列表 |
| `graph` | 无 | GET `W/owner/graph?limit=120` | `{nodes,edges}`；关系中的 `evidence[]` 保留 |
| `retrieval` | 无 | GET `W/retrieval/status` | 索引状态对象；不能用 HTTP 成功代替索引就绪 |
| `build-index` | `operationId` | POST `W/retrieval/indexes`，body `{op}` | `{index,job,reused}` |
| `search` | `query,documentIds?,entityTypes?` | POST `W/search`，body `{query,document_ids:[],entity_types:[],limit:10}` | `items`、`graph`、证据及交付字段原样保留 |
| `sensitive` | 无 | GET `W/sensitive/settings` | `enabled,semantic_enabled,revision,rules` 等 |
| `save-sensitive` | `operationId,payload` | PUT `W/sensitive/settings`，body `{op,payload}` | 更新后的保护设置 |
| `correct` | `id,versionId,segments:[{id,text}],operationId` | POST `W/documents/{id}/correction`，body `{op,payload:{base_version_id:versionId,segments}}` | 更正结果；成功后重新加载详情和任务 |

检索 `query` 长度 1～2000，`documentIds` 最多 100 项、`entityTypes` 最多 50 项。保护设置提交携带读取时的 `payload.expected_revision`；材料更正携带读取时的 `versionId`，不以列表缓存覆盖最新版本。

### 4.3 数据仓、Key 与迁移（15 个）

| action | 页面输入 | HTTP 请求 | 返回重点 |
|---|---|---|---|
| `warehouses` | 无 | GET `/warehouses` | `{items:[仓对象]}` |
| `warehouse` | `id` | GET `/warehouses/{id}` | 仓信息、计数、状态、revision |
| `create-warehouse` | `name,description?,operationId` | POST `/warehouses`，body `{op,name,description}` | 新仓对象，含 `id` |
| `keys` | `warehouseId` | GET `W/keys` | `{items:[Key元数据]}`，不返回历史 token |
| `create-key` | `warehouseId,name,days,scopes?,operationId` | POST `W/keys`，body `{op,name,days,scopes}` | `{token,key,one_time_display}`；token 重放时可能为 null |
| `revoke-key` | `warehouseId,id,operationId` | POST `W/keys/{id}/revoke`，body `{op}` | `{revoked:true}` |
| `prepare-clear` | `warehouseId,operationId` | POST `W/clear/prepare`，body `{op}` | `{confirmation_token,expires_at,warehouse}` |
| `clear-warehouse` | `warehouseId,token,typedName,operationId` | POST `W/clear`，body `{op,confirmation_token:token,typed_name:typedName}` | 清理结果；重新读取仓状态 |
| `prepare-delete` | `warehouseId,operationId` | POST `W/delete/prepare`，body `{op}` | `{confirmation_token,expires_at,warehouse}` |
| `delete-warehouse` | `warehouseId,token,typedName,operationId` | POST `W/delete`，body `{op,confirmation_token:token,typed_name:typedName}` | `{id,state}`；刷新仓列表 |
| `export-warehouse` | `warehouseId,operationId` | POST `W/exports`，body `{op}` | transfer 对象，含 `id,kind,state` |
| `transfers` | 无 | GET `/warehouses/transfers` | `{items:[transfer]}` |
| `transfer` | `id` | GET `/warehouses/transfers/{id}` | `kind,state,size_bytes,sha256,result` 等 |
| `import-migration` | `handle` | POST/PATCH/commit `/warehouses/imports` | transfer 对象；不同于材料上传结果 |
| `save-migration` | `id` | GET transfer，随后分块 GET `/warehouses/transfers/{id}/blob` | `{saved:true}` 或 `{canceled:true}` |

仓名和 Key 名长度 1～60，仓说明最多 500 字符；Key `days` 为 1～365，服务端缺省 30。

Key 缺省权限为 `documents,evidence,graph,reasoning,search` 全部五项；显式子集会保留。创建后只展示本次非空 token，避免写入页面日志和持久缓存。相同操作重放不会再次取回明文；收到 `token:null` 时说明只能看到元数据，不显示“复制成功”。

### 4.4 模型与处理配置（5 个）

| action | 页面输入 | HTTP 请求 | 返回重点 |
|---|---|---|---|
| `processing` | `warehouseId,scope?` | GET `/processing?warehouse_id=…`；`scope:"default"` 时不传 query | `effective,revision,default_revision,inherit,warehouse_id,affected_warehouses,stages` |
| `model-catalog` | 无 | GET `/processing/catalog` | `{items:[模型]}`；使用 `id,revision,available,location`，展示 name/provider 等 |
| `check-models` | `warehouseId,scope?,config:{extraction,cloud_confirmations}` | POST `/processing/check`；展开 config，加 `warehouse_id,op` | `{check_id,config}` |
| `save-models` | `warehouseId,scope?,config:{expected_revision,inherit,check_id}` | PUT `/processing`；展开 config，加 `warehouse_id,op` | 与 `processing` 相同的配置对象 |
| `reprocess-models` | `warehouseId,documents:[{id,version_id}],expectedSignature,operationId?` | POST `/processing/reprocess`，body `{op,warehouse_id,documents,expected_signature}` | `{job_ids}`，仅表示任务已提交 |

`scope:"default"` 的 check/save 发送 `warehouse_id:null`；`scope:"warehouse"` 或省略时使用当前仓。`expectedSignature` 必须来自 **`processing.effective.signature`**，不是顶层 signature。

目前抽取和敏感检测共用一个模型；不要在前端提供两套独立模型选择。OCR、ASR、embedding 展示 `stages` 的设备能力，当前这些动作不支持切换它们。

### 4.5 Skill 与推理（6 个）

本组必须传 `warehouseId`。

| action | 页面输入 | HTTP 请求 | 返回重点 |
|---|---|---|---|
| `skills` | `offset?,keyword?` | GET `W/skills?limit=20&offset=…&keyword=…` | `{items,total}`；item 的 `id,title,description,default_version` |
| `skill` | `id,path?`，默认 `SKILL.md` | GET `W/skills/{id}?path=…` | `{skill,version,files,file:{path,text,…},…}` |
| `import-skill` | `operationId?` | Electron 选择 ZIP，再 POST `W/skills/import`，body `{op,content_base64}` | 导入结果含 `skill.id`；取消返回 null |
| `download-skill` | `id` | GET `W/skills/{id}/download`；service 校验后保存 | `{saved:true}`；取消 `{saved:false}` |
| `delete-skill` | `id,operationId?,confirmation` | POST `W/skills/{id}/delete`，body `{...confirmation,op}` | 删除结果；刷新 Skill 列表并清理相关准备状态 |
| `reasoning` | `operation,arguments,operationId?` | POST `W/reasoning/{operation}`，body `{op,arguments}` | 各操作业务结果原样返回 |

Skill 删除的 `confirmation`：

```js
const confirmation = {
  expected_revision: detail.skill.skill_revision,
  expected_draft_revision: detail.skill.draft_revision,
  typed_name: userTypedTitle, // 用户输入，必须匹配当前 title
  confirm: true,
  invalidate_dependents: userExplicitlyAllowsInvalidation
};
```

### 4.6 额外 IPC 动作

`window.semantica.call("open-model-management")` 由 `main.mjs` 处理，向万象发送 `wanx:open-models`，不调用 Semantica HTTP，也不计入上述 47 个 service 动作。

返回 `{opened:boolean}`；false 时提示用户在万象管理后台打开模型管理。该动作等待约 4 秒，不应持续显示“跳转中”。

## 5. 初始化、页面状态与详情消费

### 初始化流程

1. 检查 `window.semantica`；缺失则提示从万象启动应用，停止业务请求。
2. 调用 `initialize`。四个 HTTP 请求全部成功才会返回，不能只用 `/status` 判断接通。
3. 使用 `identity` 展示账号和盒子，用 `warehouses.items` 渲染仓选择；没有仓时展示建仓入口。
4. 选仓后加载材料、任务、本人图谱、索引状态、保护设置；模型配置和 Skill 页面按需加载。
5. 页面分别展示连接状态与业务处理能力。`capabilities.managed === false` 是预期 standalone 模式，不是错误。

能力字段包括 `accepted_suffixes,document_max_bytes,processing_ready,processing_checks,ocr_ready,production_ready`。文件选择以服务能力为准。健康检查 HTTP 200、模型“已配置”、`processing_ready` 均不能替代真实处理或生产验收结果。

### 材料详情

```ts
// 关注字段摘录；其余业务字段保持原样。
type DocumentDetail = {
  document: {
    id: string;
    original_name: string;
    status: string;
    active_version_id?: string | null;
  };
  version: Record<string, unknown> | null;
  segments: Array<Record<string, unknown>>;
  segment_next_offset: number;
  blocks: Array<Record<string, unknown>>;
  block_count: number;
  processing: {
    text_ready: boolean;
    index_ready: boolean;
    graph_status: string;
    knowledge_summary: Record<string, unknown> | null;
    delivery_status: string;
    sensitive_status: "pending" | "running" | "completed" | "failed" | "not_required";
  };
};
```

正文分段可能受响应文本大小限制，下一页使用服务返回的 `segment_next_offset`，不要固定加 100。若下一 offset 不再增加或没有新 segments，停止追加。不要把 `block_count` 当作 segment 总数。

`text_ready`、索引状态、图谱状态和敏感检测状态分别显示。`delivery_status` 当前保持 pending，不能当作检测完成标志；`sensitive_status` 的 completed 表示有效检测覆盖，不表示内容不敏感。

列表保留 `active_version_id`，否则重处理流程会跳过这些材料。详情正文、文件名、Skill 源文等按文本渲染或转义，不能直接作为 HTML。

### 刷新策略

可沿用当前 UI：有 queued/running 任务或 clearing/deleting/importing 仓时约 3 秒刷新，空闲约 20 秒刷新；进行中迁移单独读取 transfer。使用 in-flight 标记避免重复请求；会话失效、页面卸载时停轮询。

仓处于非 active 状态时限制写操作，显示实际 state。`clear_failed/delete_failed/import_failed` 要展示未完成状态，不把提交成功当成完成。`graph` 当前仅取 limit=120 的视图，不应宣称展示仓内全部关系。

## 6. 上传、下载与迁移工作流

### 材料上传

```js
const files = await call("select-files");
for (const file of files) {
  // 可先显示待上传列表；失败后保留同一 handle 供用户重试。
  const result = await call("upload", { handle: file.handle });
  // result.document / result.job 用于定位；刷新列表取得后续处理状态。
}
```

空间文件先 `space-list`，只允许选择 `kind:"file"` 且没有 `problem` 的条目，再把 `{id,digest}` 数组传给 `select-space-files`。返回的 handle 与本地材料共用 `upload`。Renderer 不接触真实文件路径，不自行下载空间文件后再上传。

service 内部执行：

1. 校验文件未变，计算/验证 SHA-256。
2. POST `W/imports`，body `{operation_id,external_document_id,filename,size_bytes,sha256}`。
3. 接收 `{upload_handle,offset}` 或 `received_bytes`；如直接返回 document，使用已有结果。
4. PATCH `W/imports/{upload_handle}`，body `{operation_id,offset,content_base64}`，每块解码后最多 1 MiB。bridge 将 operation_id 放入上下文，并从上游 PATCH body 删除。
5. POST `W/imports/{upload_handle}/commit`，body `{operation_id}`。
6. commit 结果不确定时，service 查询 `W/operations/{operation_id}`，确认 committed 后复用结果。

UI 不重复实现分块协议。上传 received 表示材料已接收并提交；抽取、索引、检测进度仍从 jobs 和详情读取。前端移除文件时调用 `release-files`，它仅释放选择句柄，不撤销已提交材料或后台任务。

### 下载

- 材料 `download`：读取详情取得文件名，弹出保存对话框；分块读取 JSON blob，校验偏移、长度、整件 SHA-256 和原件一致性后替换目标文件。
- 后续材料块带 `expected_origin_revision,expected_sha256`；Renderer 不组装这些参数。
- 当前下载使用 `/blob`，不要将响应内 `original_url/preview_url` 直接作为页面 fetch 地址；它们可能仍是独立服务原生路径。
- `download-skill` 的取消返回 `{saved:false}`，材料/迁移取消返回 `{canceled:true}`，不要合并成同一种判断。
- 普通材料下载没有当前 service 的进度事件；迁移下载才发 `migration-download`。

### 迁移

导出：`export-warehouse` → 保存 transfer ID → `transfer` 轮询 → `kind:"export"` 且 `state:"ready"` → `save-migration`。

迁入：`select-migration` → `import-migration({handle})` → 读取 transfer 状态并刷新仓列表。迁入使用 `/warehouses/imports`，返回 transfer，不是 `{document,job}`。迁入 commit 失败不走材料 `/operations` 对账，不能提示用户材料式“已自动确认成功”。

## 7. 写操作交互流程

### 清仓与删仓

1. 用户进入确认流程时，分别调用 `prepare-clear` 或 `prepare-delete`，生成该准备动作的 operationId。
2. 展示返回的 `warehouse` 名称及计数，保存 `confirmation_token` 和 `expires_at`；令牌不跨仓或跨动作复用。
3. 用户输入仓名。执行时使用另一枚 operationId；同次执行重试保留该值。
4. 调用 `clear-warehouse` 或 `delete-warehouse`，传 `token,typedName`。
5. 清空对应页面的文件选择、详情、Key 展示和推理准备记录，刷新仓状态；清仓/删仓联动不能靠前端逐条删除资源模拟。

确认期间切仓或版本发生变化，丢弃旧确认流程并重新准备。服务返回冲突时重新读取，不自动替用户确认新的仓内容。

### 模型检查、保存与重处理

```js
const scope = "warehouse";
const before = await call("processing", { scope });
const catalog = await call("model-catalog");
// 用户从 catalog.items 选择 available 模型。
// 对 location !== "local" 的模型先明确确认，再使用所选模型 revision：
const checked = await call("check-models", {
  scope,
  config: {
    extraction: selectedModel.id,
    cloud_confirmations: confirmedExternalRevisions,
  },
});
await call("save-models", {
  scope,
  config: {
    expected_revision: before.revision,
    inherit: false,
    check_id: checked.check_id,
  },
});
const after = await call("processing", { scope });
// 重新处理须另经用户确认；不是保存配置的默认后续动作。
// await call("reprocess-models", {
//   operationId: crypto.randomUUID(),
//   documents: selectedDocuments.map(d => ({id:d.id,version_id:d.active_version_id})),
//   expectedSignature: after.effective.signature,
// });
```

示例中的 `selectedModel`、`confirmedExternalRevisions` 是用户选择及确认结果。云端确认按模型 revision 绑定，不能硬编码同意；后续抽取/检测可能向所选服务发送未经脱敏正文。

检查结果当前有效期 10 分钟；更换仓、模型或模型 revision 后重新检查。恢复仓继承可直接保存 `{expected_revision,inherit:true,check_id:null}`；默认配置不使用 inherit。

保存影响后续新任务，不自动重处理已有材料。重处理从当前列表选择 `status:"ready"` 且有 `active_version_id` 的材料，当前 UI 每批 100 份；每批使用独立 operationId，失败后不把整组任务标为成功。当前 service 没有暴露只处理 sensitive 的 stage 参数。

### Skill

导入完整 ZIP，成功后用 `result.skill.id` 打开包详情；`skill` 的 `path` 由 service URL 编码，保持包内相对路径。显示 `file.text` 原文，不从 Renderer 执行包内容。

删除使用当前详情的两个 revision 和用户输入 title；若 `SKILL_REFERENCED`，由用户明确选择是否使依赖失效，再重新提交合适的确认。删除或重新导入后，旧 preparation 不再作为可用结果复用。

## 8. 八种推理操作

统一入口：

```js
const result = await call("reasoning", {
  operation: "prepare",
  operationId: crypto.randomUUID(),
  arguments: {
    skill_id: selectedSkillId,
    idempotency_key: preparationKey,
    document_ids: selectedDocumentIds,
    detect: false,
    delivery_mode: "masked",
  },
});
```

`operationId` 是请求操作标识；`arguments.idempotency_key` 是推理准备的业务幂等键，两者不能互相替代。当前 UI 对同一 Skill 和材料集合复用 preparationKey，材料/方法选择改变后重建。

| operation | 当前消费的 arguments | 页面用途 |
|---|---|---|
| `discover` | `query,limit` | 发现方法 |
| `prepare` | `skill_id,idempotency_key,document_ids,detect,delivery_mode` | 建立方法与材料范围的准备记录 |
| `reference` | `preparation_id,skill_id,reference_id,detect,delivery_mode` | 读取方法引用 |
| `scope` | `preparation_id` | 查看已准备的范围 |
| `search` | `preparation_id,query,limit` | 在准备范围内查证 |
| `evidence` | `preparation_id,evidence_id` | 读取证据 |
| `read-document` | `preparation_id,document_id,detect` | 读取选定材料正文 |
| `coverage` | `preparation_id` | 查看覆盖情况 |

保留结果中的 `preparation_id,preparation_status,fully_executable,detection_status,next_action,content.references` 及各操作的交付字段。它们可能因操作而异，不要求每个响应全部存在。

- 返回 preparation_id 后，后续操作携带该 ID；不要跨仓、跨用户复用。
- `next_action:"detect_reasoning"` 时提供明确检测入口；用户操作后再以 `detect:true` 准备/读取。
- `preparation_status:"ready"` 不等于 `fully_executable:true`，更不等于推理分析已经完成。
- `unverified/failed` 如实展示；`fully_executable` 表示方法准备条件，不表示调用方已完成分析。
- `REASONING_SCOPE_CHANGED`、`REASONING_DELIVERY_STALE` 或 preparation 失效时重新准备，不在前端改状态绕过。

## 9. 错误、时限与大小限制

### 错误处理

优先使用页面已有的 code→中文提示映射，允许公开的 `publicMessage` 作为补充文本。未知错误使用通用提示，不直接展示堆栈或原始上游响应。

| code / 情况 | 页面处理 |
|---|---|
| `WANX_HOST_REQUIRED` | 提示从万象启动 |
| `HOST_SESSION_EXPIRED` / invalidated 事件 | 停止请求、清空会话数据、返回万象重连后重新打开 |
| `NETWORK_NOT_READY` | 展示网络恢复中；不宣称后台任务已取消，不自动重放写请求 |
| `WAREHOUSE_CHANGED` | 丢弃旧响应，通常不弹业务失败提示 |
| `SEMANTICA_RESOURCE_FORBIDDEN` / `SEMANTICA_RESOURCE_NOT_FOUND` | 刷新可访问资源或提示权限不足 |
| `SEMANTICA_UPGRADE_REQUIRED` | 提示检查盒端版本和路由；不能仅据此断定独立服务没有该功能 |
| `SEMANTICA_CONNECTION_FAILED` / `SEMANTICA_SERVICE_UNAVAILABLE` | 展示服务暂不可用，保留可重试状态 |
| `SEMANTICA_SERVICE_AUTH_FAILED` | 旧 managed 服务鉴权配置错误；不是 WANX 用户登录过期 |
| `SEMANTICA_VERSION_CONFLICT` / `SKILL_REVISION_CONFLICT` | 重读详情，用户确认后重新提交 |
| `WAREHOUSE_BUSY` | 展示仓状态，等待或切仓 |
| `MODEL_CHECK_REQUIRED` / `MODEL_CONFIG_CHANGED` / `MODEL_CONFIG_CONFLICT` | 重新读取模型配置，检查并确认 |
| `ACCESS_KEY_INVALID` | 提示 Key 已失效；不注销 WANX 会话 |
| `SPACE_REMOTE_FILE_CHANGED` / `SEMANTICA_LOCAL_FILE_CHANGED` | 移除旧 handle，重新选择 |
| `SEMANTICA_FILE_SELECTION_EXPIRED` | 重新选择文件 |
| `SEMANTICA_DOWNLOAD_HASH_MISMATCH` | 显示校验失败，不提示保存成功 |

service 识别的 HTTP 业务码前缀为 `SEMANTICA/WAREHOUSE/MIGRATION/ACCESS_KEY/MODEL/SKILL/REASONING`；后六类允许长度不超过 200 的公开 message。`SPACE_*`、Host 和本地文件错误来自其他调用层。错误码列表是常用子集，不是穷举。

bridge 会解包原生 `{detail:{code,message}}` 并规范化；页面不需要解析 detail。真正 WANX 会话失效仍是 HTTP 401；旧上游服务鉴权失败映射 503，开放 Key 失败映射 403，避免误触发 Host 注销。

### 请求时限

| 请求 | Electron service 超时 | bridge 上游截止 |
|---|---:|---:|
| `check-models`、`save-models`、`reasoning` | 330 秒 | 285 秒 |
| `search` | 90 秒 | 85 秒 |
| `processing`（GET 读取配置） | 60 秒 | 285 秒；bridge 按路径使用长截止，外层 60 秒先到 |
| 其他请求，包括 `reprocess-models` | 60 秒 | 45 秒 |

这是每次请求的时限；分块上传/下载总耗时可超过单请求时限。不要额外套一个更短的全局页面超时。请求超时或窗口关闭不保证已经提交的后台任务被撤销，应通过列表/操作状态核对。

### 大小限制

| 项目 | 当前约束 |
|---|---|
| 材料选择 | 服务返回的 `document_max_bytes`；service 缺省 1 GiB，格式以 `accepted_suffixes` 为准 |
| 材料原件下载 | service 上限 1 GiB |
| 分块上传/下载 | 每块解码后最多 1 MiB |
| 迁移包 | `.xingtu/.zip`，最大 2 GiB |
| Skill ZIP 导入 | ZIP 最大 4 MiB；解压文本最多 8 MiB，另受服务端包校验 |
| Skill 下载 | service 最多 8 MiB，并校验 SHA-256 |
| bridge 桌面请求 body | 通常 2 MiB，Skill 导入 6 MiB；不是原始文件总大小限制 |

不要把大文件一次性 base64 放入普通请求，也不要把 ZIP 上传替换成原生 multipart；这些步骤由 service 完成。

## 10. 开放接口及当前未提供的页面动作

知识开放接口供带 Key 的消费方使用，不能代替本人管理接口。通过 Host 使用 `/api/semantica/open/v1` 前缀和 `X-Xingtu-Key`；bridge 校验当前万象会话后把 Key 转成上游 Bearer。

| 方法与相对路径 | 请求 | Key 权限 |
|---|---|---|
| GET `/warehouse` | 无 query | documents；读取其绑定仓摘要 |
| GET `/documents` | `limit,offset` | documents |
| GET `/graph` | `limit,entity_id?` | graph |
| POST `/search` | `{query,document_ids?,entity_types?,limit?}` | search |
| GET `/evidence/{id}` | 无 query | evidence |
| POST `/reasoning/{operation}` | `{arguments:{…}}`，八种操作同上 | reasoning |

开放推理不使用本人动作的 `{operation_id,arguments}` 包装。Renderer 当前没有上述开放接口的专用 service 动作；需要新页面调用时先扩展明确的 IPC/service 契约，不能从渲染进程取得 Host 凭据。

当前 47 个动作也没有“取消任务”“单材料删除”“替换全文”“跨 workspace 检索”等页面入口。即使后端存在相关能力，也不应假设 `call("cancel-job")` 等动作可用；后续新增需要同时补 service、桥接映射核对和消费者契约测试。

## 11. 开发验收与证据边界

### 已有自动化

在 WANX 仓库根目录执行：

```powershell
# Node 22；第二个参数是实际 STARLINK 仓库根目录。
node wanx-bridge/tests/contracts/starlink.contract.mjs D:/项目文件/startlink

# bridge 桌面/原生入口、模型回调及网关鉴权回归。
uv run --python 3.12 --project wanx-bridge pytest -c wanx-bridge/pyproject.toml wanx-bridge/tests/test_semantica_desktop_contract.py wanx-bridge/tests/test_semantica_model_relay.py wanx-bridge/tests/test_semantica_native.py wanx-bridge/tests/test_gateway.py wanx-bridge/tests/test_auth.py -q
```

最近一次已记录结果：Node **61 通过**，覆盖全部 47 个 service 动作与 8 种推理操作；Python **248 通过、2 跳过**。Node 用真实 service 和 mock Host，Python 使用模拟上游/模型，均不等于实际 Electron→Host→运行中 bridge→Semantica 全链路验收。

另已核对 Semantica 的 73 个展开方法/操作组合及请求 schema。多数集成响应没有完整的细粒度 response_model，不能仅凭 OpenAPI 校验声称全部真实返回已验证。

重启后的 standalone 服务已做无签名上下文的 status/capabilities 只读验证；该检查没有经过运行中的 WANX bridge，也未执行真实材料处理、模型推理或破坏性业务操作。

### 前端与真实链路验收清单

- [ ] 从万象启动，初始化四请求成功，账号/盒子正确；standalone 显示为正常模式。
- [ ] 切仓期间旧请求不污染新页面；会话失效后清空内容并停止操作。
- [ ] 本地与空间文件各完成一次上传，验证进度、材料任务及正文状态；同 handle 重试不重复建材料。
- [ ] 原件、Skill、迁移包下载校验成功；取消保存不会显示成功。
- [ ] 本人图谱显示证据；检索、正文分页和更正版本冲突处理正确。
- [ ] 修改保护设置带 expected_revision，检测与交付状态没有被合并为“安全”。
- [ ] 使用测试仓验证建仓、Key 一次展示/撤销、清仓/删除二次确认及后台状态。
- [ ] 模型检查/保存成功；恢复继承、revision 变化、云端确认和批量重处理状态正确。
- [ ] Skill 导入/文件阅读/删除及八类推理结果消费正确；失效准备必须重建。
- [ ] 普通用户无权限、网络中断、上游不可用、仓忙等错误提示正确。

涉及写入、清仓、撤 Key 的验收使用专门测试仓。上述清单是待执行验收，不代表本次文档工作执行了这些操作。

## 12. 契约维护位置

| 仓库 | 文件 | 用途 |
|---|---|---|
| STARLINK（当前目录名 startlink） | `desktop/shell/preload.cjs`、`main.mjs` | 页面 API、IPC 包装、模型管理跳转 |
| STARLINK | `desktop/shell/service.mjs` | 47 动作、请求转换、文件流、超时及事件的直接依据 |
| STARLINK | `desktop/ui/app.js`、`native-skills.js` | 现有页面状态、错误提示、模型与推理交互参考 |
| WANX | [desktop.py](../wanx_bridge/semantica/desktop.py)、[desktop_routes.py](../wanx_bridge/semantica/desktop_routes.py) | HTTP 允许列表、上游映射、上下文、权限及错误转换 |
| WANX | [STARLINK 消费者契约](../tests/contracts/starlink.contract.mjs) | 完整动作覆盖、请求参数、结果消费、文件及错误测试 |
| WANX | [bridge 桌面契约测试](../tests/test_semantica_desktop_contract.py) | bridge 转发与权限边界 |
| WANX | [Semantica 契约核对脚本](../tests/contracts/semantica_contract.py) | 上游 schema、序列化和上下文核对 |
| Semantica | `app/api/integration.py`、`warehouses.py`、`processing.py`、`managed_reasoning.py` | 当前集成请求模型、业务路由及部分响应模型 |

新增或变更动作时，同步更新本文、service 和对应契约用例。不要把 README 中用于说明拆分差异的“原生 API 对照”直接当作新的前端调用目标。
