# 星图 STARLINK

万象独立应用的当前入口、构建安装与配置见 [desktop/README.md](desktop/README.md)。当前 macOS 开发版本为 0.2.21，知识抽取与脱敏统一选择万象在线模型，OCR、语音与向量保持本地配置。模型使用记录、仓级授权与资料来源保存在星图服务端。

本次原生接入与验收见 [STARLINK 原生推理与 Skill 验收](docs/STARLINK原生推理与Skill验收-20261019.md)。此前本机验收与兼容边界见 [STARLINK 在线模型与品牌验收](docs/STARLINK在线模型与品牌验收-20261017.md)。以下保留原工作台的 Windows 独立开发说明。

## starlink-merge 合并说明

本分支整合 `starlink` 的桌面端、万象模型接入、知识仓及只读开放接口，与原工作台的 Skill ZIP 管理、默认连续检索指引、自动重试、检索与分块性能修复。网页工作台和桌面端保留各自入口；Skill 页面及推理 MCP 工具仍沿用 standalone 访问边界，本次没有新增桌面 Skill 页面或放开 managed 管理权限。

数据库统一升级到 schema 19，支持原 STARLINK schema 11 和原工作台 schema 18。启动前沿用既有 `BACKUP_HMAC_KEY` 配置并保存好密钥；旧实例尚未配置时应先按部署文档配置。启动会先创建并校验备份，再执行升级；备份失败会停止启动。全量备份包含 Skill 附件和知识仓迁移文件。升级后的数据库不能直接交给旧分支运行，回退须使用升级前备份及匹配的旧代码。

旧 schema 11 的 `.xingtu` 材料迁移包仍可导入，继续严格检查格式、列结构、文件摘要和范围。`.xingtu` 与 Skill ZIP 是不同格式；知识仓材料导出不隐式包含 Skill 或模型凭据。

自动重试保留万象任务原模型快照；原生 LLM 配置在扫描中变更仍会使旧扫描失效。本地模型请求跳过系统代理，并保留同一任务内的连接复用。不增加新的功能开关。

## 原工作台开发环境

## 系统默认推理流程（2026-10-17）

通用分析与连续检索规则由 `config/reasoning_skills/general-reasoning/SKILL.md` 统一维护，MCP 在进程启动时加载其中的六阶段指引与正文。不需要导入数据库、发布或增加启用参数，也不在方法列表或可安装示例中自动创建条目。专业 Skill 继续通过 ZIP 管理，外部 Agent 自带的专业 Skill 也能结合默认指引使用。

流程包括：拆分子问题、检索并读取重要原文、根据新线索或缺口继续查询、核对反例并避免重复查询、达到依据充分／无有效新证据／用户预算时停止并说明不足。简单问题不强制多轮检索；这些是 Agent 指引，不是后端自动推理循环或专业准确性保证。

MCP 服务与工具说明使用中文，工具名、参数名和协议状态标识保持兼容。列举 Skill 只需发现已发布摘要，分页结束后即可回答；摘要 `fully_executable=false` 不代表列举失败。普通材料事实、项目阶段或安排查询直接使用 `search_knowledge`，不需要先准备专业 Skill。组合问题分别完成方法列表和材料查询；明确要求知识库来源时不自行改为扫描本地代码目录，项目指代不明时先澄清。

`get_evidence` 同时接受搜索结果 `items[].id` 与图谱关系来源的证据 ID，没有图谱关系的正文也可核对。检索片段只允许从活动索引和当前未删除的正文版本读取；返回 `evidence_kind=search_chunk`、`fact_id=null`，不伪造图谱关系。原有敏感交付、确认令牌、固定材料范围和版本校验继续生效。Agent 应合并简单查询，按文档版本和原文位置去重；404 后不盲目重复相同 ID。

目录响应新增 `page_status`（当前页 `complete`／`needs_detection`／`partial`）。目录、方法准备与引用读取返回 `detection_requested`，表示本次请求是否显式要求检测，命中缓存时不代表实际调用了模型。显式检测后仍未完成时保留受限状态，但不再返回自动检测指令，MCP 确认流程也保留该停止状态。Agent 应说明限制并停止重复检测。其他分页及独立材料查询仍可继续，用户要求或条件恢复后允许再次显式检测。用户确认交付原文不会将检测状态改为成功，也不要求重新检测才能使用已授权原文。更新后重启后端与 MCP，并让外部 Agent 重新连接以加载中文说明；接口约束测试不能代替真实 Agent 的工具选择验收。

旧专业包对 `general-reasoning` 的依赖，在当前工作空间没有同名数据库方法且版本兼容时，由系统默认流程满足；已有同名方法保持可见、可管理，优先使用其发布版本，不绕过草稿、停用或不兼容状态。其他自定义依赖不会被替换。已创建准备记录绑定所用内容摘要，默认流程变化或依赖内容改变时需重新准备；本次不改写历史方法、版本及数据库表结构。

部署时必须包含上述默认文件（现有发布脚本已包含 `config`）。修改文件后重启 MCP 及使用该依赖解析的后端进程，再让外部客户端重新连接。文件缺失或格式无效会明确报错，不会悄悄丢失默认规则。敏感交付、材料范围与引用校验保持有效。

## Skill 管理与日常分析

推理方法当前采用“日常分析”路径：外部 Agent 通过 MCP 发现并读取 Skill、检索或阅读材料，在当前对话中给出带来源、反例和信息缺口的分析。无需返回工作台确认事实；已移除“方法使用”页面、证据候选人工确认、事实计算及报告保存运行接口。现有敏感内容交付确认仍保留，与业务事实确认不同。

“推理方法”页面改为 **ZIP 导入、层级文件查看、ZIP 下载和删除**，不再提供正文编写、规则编辑和发布操作。导入校验通过后即发布可用版本；同名 Skill 拒绝覆盖。旧方法和草稿保留查看、导出、删除能力，旧管理 API/内部版本及依赖校验继续用于兼容和导入，不再要求用户逐项编辑发布。

ZIP 支持根目录 `SKILL.md`，或唯一外层目录下的 `SKILL.md`。每包一个方法；更深层的 `SKILL.md` 是附属文档，不单独注册。保留多层目录、相对路径及文件字节，页面按目录查看 UTF-8 源文档，Markdown 标题不被压平。脚本作为文本保存，不在服务端执行。暂不接收图片、可执行程序等二进制资源。

```text
my-skill/
  SKILL.md
  references/
    guide.md
    cases/
      example.md
```

最小 `SKILL.md`：

```markdown
---
name: my-skill
description: 对指定材料进行对比，列明来源与信息缺口。
---
# 分析步骤
先读取相关材料，再对照 references/guide.md 分析。
区分原文陈述、分析推断和信息不足；结论附来源。
```

`name` 使用小写字母、数字及连字符，必须以字母开头；可提供 `title` 和三段版本号 `version`，默认版本 `1.0.0`。也支持原有 Semantica 结构化 SKILL.md（通用、场景、专业扩展及依赖），其附件可通过本页 ZIP 下载后重新导入。历史清单作为可读指导保留，不作为自动确认的可执行规则。ZIP 最大 4 MiB，展开后合计 8 MiB、最多 50 个文件、单文件 256 KiB；文件路径最长 180 字符。拒绝穿越路径、符号链接、重复路径、加密 ZIP 及非 UTF-8 文本。导入失败回滚，不留下半发布方法。

当前 SQLite 数据格式版本为 **19**，正常启动会先备份旧库再升级，仅更新兼容性标记，不删除或重写旧方法、材料和历史核查记录。保留历史表及迁移定义，以支持旧库升级和备份；旧正式核查记录不再提供使用入口。回退代码应使用匹配版本的升级前备份。MCP 默认 **9 个工具**，没有新增启用开关。

新版代码部署后，正常启动会自动比较 SQLite schema：旧库先备份并校验，再迁移；同版本直接启动，新实例直接初始化。无需额外升级命令或启用开关，复用已有 `BACKUP_HMAC_KEY`。备份位于 `backups/pre-migration/`，失败时停止启动。详见 [启动自动升级](docs/Linux部署与持续更新.md#启动时自动检测数据库升级)。

若还需要在覆盖代码前保存旧代码、依赖和实例配置，可使用 `python scripts/remote_deploy.py update --host 192.168.0.103 --user user` 完成整次发布；首次使用先按 [Linux 部署说明](docs/Linux部署与持续更新.md#推荐一条命令完成备份和更新)准备部署环境和 SSH 临时凭据。启动自动备份不会下载新版代码，也不能保存已经被覆盖的旧代码。

目录：`D:\项目文件\semantica`。Python 3.11 虚拟环境安装；不使用 Docker，不安装 Neo4j/Ollama，不全局安装 Python 包。

本目录用于开发和验证。I0–I8 已完成独立骨架、多格式材料与校对、知识抽取、Neo4j 知识网络、版本化检索、独立交付、个人模式自动流水线、外部 Agent MCP，以及语义切块和高精度个人知识图。实际结果见 `SETUP-STATUS.md` 和 `docs/` 下各阶段验收记录。

后续研发按 [独立知识网络工作台开发迭代指引](docs/开发迭代指引.md) 推进：涵盖多格式上传、OCR/ASR、本地向量、本体、知识网络与检索。MindOS 仅可作为一次性模型文件来源，新项目不依赖其代码、服务、虚拟环境或运行路径。

## STARLINK 经万象接入 standalone

调用链为 `STARLINK → 万象 bridge → Semantica`。无需改为 managed：
`/api/integration/*` 在两种部署模式下均验证万象服务签名，并建立账号、数据仓和操作上下文；
用户登录及业务权限仍由万象管理。原生工作台及 standalone MCP 保留原有访问方式。
开放 `/api/open/v1/*` 沿用知识 Key 校验，并统一拒绝浏览器 Origin、限制请求体为 128 KiB、禁止响应缓存。

接入时复用现有 `INTEGRATION_SERVICE_TOKEN`（至少 32 字符的随机密钥）、
`INTEGRATION_BOX_ID`、`INTEGRATION_APPLICATION_ID`，与 bridge 的配置保持一致。
未配置时仍可独立使用原生工作台，集成请求返回 401；错误配置不会降级为匿名集成访问。
密钥只在服务之间使用，不交给 Electron，也不要求用户再次登录 Semantica。
这是集成身份校验，不会使保留开放的 standalone 原生端口变成用户权限网关；桌面业务仍应走万象入口。

模型回调默认使用 `WANX_MODEL_URL=http://127.0.0.1:18089`，对应 bridge 的私有
`/internal/starklink/models` 接口；既有显式 URL 配置优先。两服务需共享该回环地址所在的网络命名空间。
代码更新后重启后端进程生效；本次不自动改写实例 `.env`、密钥或已有模型配置。

standalone 也启动处理能力监测，`processing_checks` 返回真实缓存的依赖状态及 worker 状态。
`embedding_prepared` 沿用本地模型清单与文件检查，远程 embedding 不据此宣称就绪；
模型 API 配置完整不代表实际推理已验证。健康接口可用也不等于 `processing_ready` 或 `production_ready`。
监测不下载模型、不执行推理，图数据库使用有超时的只读常量查询。

## 进入开发终端

在 PowerShell 执行（只为当前进程设置执行策略，不改系统策略）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -NoExit -Command ". 'D:\项目文件\semantica\Initialize-Session.ps1'"
```

在启动后的开发终端中操作；编辑器选用 `D:\项目文件\semantica\.venv\Scripts\python.exe`。从其他终端或编辑器启动程序前，也要配置同样的环境变量。

脚本将包、下载缓存、模型缓存及安装临时文件指向本目录。禁用用户级 Python 包，禁止全局 pip 安装。已有基础 Python 可位于 C 盘，不迁移已有软件。操作系统自身写入及不遵守配置的第三方插件不在这些变量的强制隔离范围内；其他插件必须另行核实其安装/数据/缓存路径，不能默认为允许写 C 盘。

## 安装或恢复依赖

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\项目文件\semantica\Install-Dependencies.ps1
```

`requirements.txt` 是直接依赖约束。安装成功后生成 `requirements.resolved.txt` 记录实际版本；`reports/` 保存安装解析报告。不要编辑 `.venv/Lib/site-packages`，框架扩展通过独立源码分支或 wheel 管理。

## 本地验证（无需服务密码）

也可一条命令准备环境并执行全部本地检查：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\项目文件\semantica\Test-Environment.ps1
```

准备上述开发终端后运行：

```powershell
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\python.exe check_environment.py --imports-only
.\.venv\Scripts\python.exe check_local.py
```

基础本地测试只使用合成数据，验证依赖、FastAPI 进程内请求、Semantica ContextGraph、RDF/SHACL 及 Qdrant 持久化/召回，不加载本地模型或连接远程数据库。I0 模型检查由下节的 `Test-I0.ps1` 执行；Hugging Face 始终默认离线。测试数据使用独立目录，不清除现有应用数据。

## I0 应用与本地模型

安装 I0 的 CPU 模型运行库及前端依赖，并生成前端生产构建：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\项目文件\semantica\Install-I0-Dependencies.ps1
```

模型迁入工具只从旧项目读取三个已批准目录，复制到本项目并逐文件校验 SHA-256，不修改原件：

```powershell
.\.venv\Scripts\python.exe scripts\migrate_models.py
```

启用本地 Embedding 时只修改选择器；外部 Embedding 配置可以保留：

```dotenv
EMBEDDING_PROVIDER=local
EMBEDDING_LOCAL_PATH=models/embedding/bge-small-zh-v1.5
EMBEDDING_DEVICE=cpu
EMBEDDING_NORMALIZE=true
EMBEDDING_BATCH_SIZE=8
EMBEDDING_CHUNK_TARGET_TOKENS=384
EMBEDDING_CHUNK_MAX_TOKENS=480
EMBEDDING_CHUNK_OVERLAP_TOKENS=64
```

本地模式强制从项目目录加载，不会联网补模型。文档向量不加查询指令，查询向量使用 `EMBEDDING_QUERY_INSTRUCTION`；当前 BGE 实测为 512 维。切换模型、维度、归一化方式或查询指令后必须新建索引版本。

完整离线回归和可选服务联调：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Test-I0.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\Test-I0.ps1 -Services
```

启动开发服务：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Start-Development.ps1
```

默认访问 `http://127.0.0.1:8090/`；页面/API 的实际监听地址和端口读取 `.env` 的 `APP_HOST`、`APP_PORT`。默认使用回环地址；局域网部署可配置 `APP_HOST=0.0.0.0`，并设置对应浏览器访问地址 `APP_PUBLIC_URL`。I7 同时启动独立 MCP 子进程，默认监听 `0.0.0.0:8091`。后端使用实例锁保护 SQLite 任务库和 Qdrant Local，不能同时启动第二个应用实例。API 文档位于 `/docs`。

运行期间的就绪检查只读数据库版本和任务表、检查存储目录与工作线程，不再执行数据库初始化或迁移。健康探测直接连接本地服务，不使用系统代理；MCP 健康检查使用异步请求，不与工具调用争用线程池。正常运行时每次探测结束后等待 15 秒；启动等待和首次失败后的复查间隔为 2 秒。空闲等待期间每 2 秒检查子进程存活，不额外发送 HTTP；服务任务退出会立即唤醒等待。外层请求超时为 8 秒，MCP 到后端的连接／读取超时为 1／3 秒，单次上游探测总时限为 5 秒。连续失败至少 3 次且持续至少 30 秒才关闭服务，恢复正常后重新计时。仅过滤成功健康检查的服务端访问日志和本机 HTTPX 客户端 INFO 日志，保留失败、恢复及业务请求日志。手工停服期间的探测失败不会转为健康故障；工作线程重新接到任务后清除旧错误状态。控制台会记录探测地址、HTTP 状态或异常类型、失败次数，以及工作线程异常堆栈。无需增加配置参数；持续故障仍需排查，不能将短暂容错视为任务已完成。

### Linux 原生部署

本次部署目录为 `/home/user/services/semantica`，使用独立 Python 3.11 虚拟环境、CPU 版 PyTorch、本地 BGE/RapidOCR/Whisper 模型及 Qdrant Local，无需 Docker。依赖通过 `requirements-linux.txt` 安装，使用 `requirements.resolved.txt` 固定已验证版本；`scripts/start-linux.sh` 配置项目内缓存及离线模型加载。已有前端构建位于 `frontend/dist`，服务器提供页面时无需 Node.js。

局域网配置：

```dotenv
APP_HOST=0.0.0.0
APP_PORT=8090
APP_PUBLIC_URL=http://192.168.0.103:8090
MCP_ENABLED=true
MCP_HOST=0.0.0.0
MCP_PORT=8091
NEO4J_NAMESPACE=deployment_192_168_0_103
```

`NEO4J_NAMESPACE` 在同一个外部 Neo4j 数据库中隔离不同安装的工作空间，应用接口仍使用 `default`。原本地安装保持该值为空；新安装在第一次发布前确定该值，不要在已有图数据发布后直接改动它。新部署未迁移本地材料、SQLite、检索索引及脱敏设置，上传材料后自动建立知识网络和检索索引。

由 `deploy/semantica-workbench.service` 注册为用户级 systemd 服务，并启用用户 lingering，退出 SSH 或重启机器后仍会自动运行。通过 SSH 登录后管理：

```bash
systemctl --user status semantica-workbench.service
systemctl --user restart semantica-workbench.service
systemctl --user stop semantica-workbench.service
journalctl --user -u semantica-workbench.service -f
```

连接配置保存于项目 `.env`；页面上更新的共享 LLM 连接保存于 `data/llm-connection.json`。部署检查 `scripts/check_deployment.py` 验证页面、实际 LLM/Neo4j 连接、本地 512 维向量及临时 Qdrant 召回、OCR/ASR 模型加载和 MCP 工具发现，不向生产材料库添加测试材料。

2026-10-05 已在 `192.168.0.103` 完成原生部署验收：Ubuntu 环境下 122 项测试通过，实际 LLM/Neo4j 连接、本地模型和向量召回通过，外部电脑可访问页面及调用 MCP。工作台地址为 `http://192.168.0.103:8090/`，无 Key 的 Streamable HTTP MCP 地址为 `http://192.168.0.103:8091/mcp`。原占用 8090 的 `sensitive-delivery-sidecar.service` 已停用并禁用自动启动，原文件和数据保留；服务器防火墙已放行 8091/TCP。新实例未迁移材料或脱敏设置；当前版本在未保存设置的工作空间默认开启交付脱敏和 LLM 语义敏感识别，已有保存值保持不变。验收结果保存于 `reports/native-deployment.json`。

首次安装、部署前提、保留数据更新、验收标准、配置、回滚和排障步骤见 [Linux 部署与持续更新](docs/Linux部署与持续更新.md)。当前实例更新按 `checkpoint → sync-code → 按需 install → test-runtime → start-service → verify` 执行。部署辅助脚本包含固定地址和目录，迁移服务器前按文档适配。Trae Work 可直接导入 [MCP 配置](deploy/semantica-mcp.json)。首次空实例验收使用 `--expect-empty`；常规更新使用普通验收。

## I1 文档上传与任务

首页提供文档库、批量选择上传、来源片段详情和任务中心。I1 支持 `.txt`、`.md`/`.markdown`、`.docx` 和含可提取文字的 `.pdf`；旧式 `.doc` 会提示另存为 `.docx`。

任务中心默认展示最近 7 天更新的任务；排队、运行及失败任务会继续显示，便于查看和重试。后台每天分批清理超过保留期、已成功或取消且没有业务引用的任务；现存材料的解析任务、知识运行、索引及当前活动索引所需的脱敏扫描仍保留内部任务记录，但不占用过期历史列表和总数。可用 `JOB_HISTORY_RETENTION_DAYS` 调整天数；清理仅涉及任务及其扫描运行记录，不删除材料、知识或检索索引。

任务中心和材料详情会显示知识候选数量、已入图数量及可展开的未入图原因。任务完成但没有有效关系时会明确标注，正文仍可检索；历史记录直接从已有候选汇总，无需重新调用模型。删除材料后的索引提示跟随任务完成、替代、取消或失败状态更新，不受任务翻页影响。

脱敏扫描因材料或图谱更新而被新任务接替时，任务中心将旧任务标为“已合并”；从未启动的旧任务显示“无需执行”，可展开历史记录并查看接替任务状态。普通排队任务显示“尚未执行”，真正取消且未开始的任务显示“未执行”。

原件使用 UUID 目录保存在 `data/originals/`，结构化结果保存在 `data/derived/`，文档元数据、不可变版本、来源片段和任务检查点保存在 SQLite。原始文件名只作显示，不参与存储路径。删除需要显式确认：材料立即退出检索并失效独占的文本缓存，持久清理任务随后移除图证据、向量点、原件、预览、解析版本及仅由该材料产生的缓存。清理失败可重试；任务完成前页面不会声称已彻底删除。删除针对当前实例；已有历史备份是独立快照，不会自动改写，需按备份保留策略单独处理。

默认单文件上限为 25 MiB、文本 PDF 为 300 页、DOCX 展开后为 256 MiB，可通过 `.env` 中以下字段调整：

```dotenv
ORIGINALS_DIR=data/originals
DERIVED_DIR=data/derived
DOCUMENT_MAX_BYTES=26214400
DOCUMENT_MAX_PDF_PAGES=300
DOCUMENT_MAX_DOCX_EXPANDED_BYTES=268435456
```

执行 I1 全量回归；`-IncludeI0Models` 会额外重新加载三套本地模型：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Test-I1.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\Test-I1.ps1 -IncludeI0Models
```

主要 API：`POST /api/documents`、`GET /api/documents`、`GET /api/documents/{id}`、`GET /api/documents/{id}/original`、`DELETE /api/documents/{id}?confirm=true`、`GET /api/jobs`、`POST /api/jobs/{id}/retry` 和 `/cancel`。上传返回 `202`；同工作空间、同内容和同解析格式的重复上传返回已有文档，不会新增任务。

## I2 图片、扫描 PDF 与校对

上传白名单增加 `.png`、`.jpg`、`.jpeg`。图片会经过 EXIF 和文字方向归一化后由项目内 RapidOCR 离线识别；PDF 逐页检查可用文字，只渲染并 OCR 缺少有效文字的页面，混合 PDF 的文字页不会重复 OCR。预览 PNG、识别框坐标、置信度、旋转角度和处理参数随内容版本保存，详情页可点击文字定位到对应图像区域。

低置信度结果会标记待复核。详情页可编辑当前完整片段集；保存后创建 `corrected` 子版本并切换活动版本，原始 `parsed` 版本及其来源坐标保持不变。并发提交旧版本会被拒绝，避免覆盖后来校对。

OCR 相关配置：

```dotenv
PREVIEWS_DIR=data/previews
DOCUMENT_MAX_IMAGE_PIXELS=40000000
OCR_RENDER_DPI=144
OCR_MIN_CONFIDENCE=0.55
OCR_PDF_TEXT_MIN_CHARS=12
```

执行 I2 全量回归；默认会真实加载本地 OCR 模型，`-IncludeI0Models` 额外回归本地 Embedding 和 ASR：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Test-I2.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\Test-I2.ps1 -IncludeI0Models
```

I2 增加 `GET /api/documents/{id}/versions`、`PATCH /api/documents/{id}/content` 和 `GET /api/documents/{id}/pages/{page}/preview`。最后一个接口会返回已缓存的 OCR 页面预览，也可按需渲染文本 PDF 页面。验收结果见 [I2 验收记录](docs/I2-验收记录.md)。

## I3 音频转写与时间证据

上传白名单增加 `.wav`、`.mp3`、`.m4a` 和 `.flac`。应用使用 PyAV 内置的 FFmpeg 库检查真实容器、单音轨、无视频、可解码采样和时长，不要求安装全局 `ffmpeg.exe`。通过校验后，项目内 faster-whisper small 模型以 CPU/int8 离线转写；默认固定中文语言，同时保留英文内容，30 秒受控分块，并在片段边界检查取消和超时。

每个转写片段保存开始/结束秒数、平均对数概率、无语音概率、压缩比和独立的低质量标记。详情页提供原音频播放器；点击片段会跳到对应时间并开始播放，播放进度也会选择当前片段。人工校对复用不可变版本契约，时间证据保持不变。

默认配置：

```dotenv
ASR_LANGUAGE=zh
ASR_BEAM_SIZE=5
ASR_VAD_FILTER=true
ASR_CHUNK_LENGTH_SECONDS=30
ASR_MAX_DURATION_SECONDS=7200
ASR_TIMEOUT_SECONDS=1800
ASR_MIN_AVG_LOGPROB=-1.0
ASR_MAX_NO_SPEECH_PROBABILITY=0.6
```

单文件仍受 `DOCUMENT_MAX_BYTES` 限制。音频上限默认 120 分钟；损坏、多音轨、含视频、容器与扩展名不符、静音无结果和超限材料都会得到明确错误。

执行 I3 全量回归；`-IncludeEmbedding` 会额外加载本地 BGE 并验证 Qdrant 召回：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Test-I3.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\Test-I3.ps1 -IncludeEmbedding
```

### 页面阶段性手工测试

I3 在后端音频闭环和前端播放器构建完成后即可进行页面手工测试，无需等待 I4。运行 `Start-Development.ps1` 并打开 `http://127.0.0.1:8090/`，上传一份白名单音频，检查任务完成、播放器可播放、片段点击跳转、播放进度选择片段、校对保存新版本以及刷新后结果仍存在。首次音频任务需要加载约 464 MiB 的本地模型文件，耗时会高于后续任务。

真实四格式验收和资源记录见 [I3 验收记录](docs/I3-验收记录.md)。

## I4 本体、候选审核与知识网络

顶部导航增加“本体版本”“候选审核”和“知识网络”。每个本体版本定义实体类型、属性、必填项、关系类型、起点和终点约束；修改通过新草稿完成，发布后旧版本自动标记为 `superseded`。首次进入工作空间会建立包含 `PERSON`、`ORG`、`GPE` 以及 `WORKS_AT`、`LOCATED_IN`、`BORN_IN` 的基础已发布版本。

“候选审核”对解析完成的活动正文启动持久化异步任务。当前选择的 LLM 通过 Semantica 执行实体和关系抽取；长正文按来源片段分批处理，不会静默截断前 32,000 字符。SQLite 同时固定保存正文版本、本体版本、模型、提供商和提示词版本。应用再次执行严格本体校验，非法类型、关系方向、端点和缺少共同来源片段的候选进入 `invalid` 隔离状态。审核者可以修正规范名、类型、别名、属性、消歧标识、关系类型和端点后批准，也可拒绝候选。同名实体默认使用不同消歧标识，不会自动合并；需要跨材料合并时应人工给出相同规范名和消歧标识。

只有审核完成的事实才能进入发布任务。应用使用固定标签和参数化 Cypher 写入 `SemanticaI4Entity`、`SemanticaI4Fact` 和 `SemanticaI4Evidence`，模型不会生成或执行数据库语句。每条事实至少有一个文档版本、片段及页码/坐标/时间定位证据。Neo4j 不可用时发布任务失败并保留重试入口，不会把批次标为已发布。删除文档或保存新校对版本会立即在本地停用旧证据，并创建远端撤销任务；远端失败时旧事实不会继续显示，任务可恢复后重试。共享事实仍有其他证据时会保留。

主要 API：`GET/POST /api/ontologies`、`POST /api/ontologies/{id}/publish`、`POST /api/documents/{id}/knowledge`、`GET /api/knowledge/runs/{id}`、`PATCH /api/knowledge/candidates/{id}`、`POST /api/knowledge/runs/{id}/publish`、`GET /api/graph/neighborhood` 和 `GET /api/evidence/{id}`。

当前知识网络工作台支持点击图中节点查看其相关事实，点击节点不会默认选择第一条关系。选择关系列表或图中的连线后，页面显示“主体 → 中文关系 → 客体”、关系方向和对应来源片段；中文类型及关系名称优先使用已发布本体中的标签。来源优先展示同段提及两端实体的摘录，只有一端名称或采用其他表述的片段折叠在“关联上下文”中，实体名称及别名在摘录中高亮。此分组只帮助核对来源，不是对关系真伪的额外判定，片段数量也不代表独立证明次数。点击“返回全图”清除选择，“刷新”重新读取图数据。材料导入后仍通过自动流水线形成知识网络。

执行 I4 回归。默认会调用已配置的真实外部 LLM 和 Neo4j，并使用随机工作空间完成写入、重启读取、文档撤销和清理；仅做离线/模拟回归时加 `-SkipRemote`：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Test-I4.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\Test-I4.ps1 -SkipRemote
```

### I4 页面手工测试

I4 已到可以从页面验证完整知识网络闭环的阶段。运行 `Start-Development.ps1` 并打开 `http://127.0.0.1:8090/`：先在“本体版本”确认或创建并发布本体；在“材料与校对”上传并校对材料；到“候选审核”选择材料并开始抽取，等待任务中心完成后审核候选并发布；最后到“知识网络”点击实体展开有限邻域、选择关系核对证据。还应断开一次 Neo4j 后尝试发布，确认任务显示失败且可重试，再恢复连接重试。使用外部 LLM 时，材料正文会发送给所配置的模型服务，请只使用允许外发的测试材料。

真实验收结果见 [I4 验收记录](docs/I4-验收记录.md)。

## I5 版本化索引与证据检索

顶部导航的“证据检索”索引已解析材料的当前正文版本，无需等待知识图谱发布。后台任务把解析器产生的细粒度来源片段按结构合并成语义工作块，再使用当前显式选择的 Embedding 写入独立 Qdrant Local 集合。当前本地 BGE 配置以 tokenizer 计数，目标 384 token、硬上限 480 token、重叠 64 token；标题附着到正文，Markdown 分隔符不会独立入索引，PDF/图片不跨页，音频保留合并后的起止时间。SQLite 保存每个向量块到全部来源片段的映射，因此合并不会损失页码、段落、行号、坐标或时间证据。

新增材料更新索引时，正文版本、正文校验值和索引配置未变化的材料直接复用活动索引中的分块及原文定位，并刷新图谱派生的实体类型；新增或变化的材料才重新分块，向量仍按文本和模型配置复用。新集合完整构建后才切换为活动索引，失败或取消不会发布半成品。长文本分块采用有限窗口计数，避免反复对整段剩余正文分词。任务中心显示模型准备、分块准备、向量计算和索引写入的耗时，以及分块复用、新分块和新向量数量。升级此分块算法后的首次索引更新需重新分块，之后可复用新版本分块；不需要额外启用参数。

检索组合向量、关键词和实体命中，并只对最多 3 个命中实体读取有限 Neo4j 邻域。结果按正文块去重，展示召回通道、检索得分、材料名称、原始定位、原件及来源页入口。文档筛选和实体类型筛选会下推到向量查询；校对、删除、失败或非当前版本在查询时即被过滤。Embedding 模型、服务地址、归一化、查询指令或实际维度变化后，旧集合不会被误用，页面会要求创建新索引。检索只返回证据，不生成无来源回答。

页面与 MCP 共用相关性过滤：先独立召回向量、关键词和图事实候选，再综合筛选，最后计算排序加分。纯向量结果默认至少达到 `0.50` 的余弦得分。关键词检查文件名和正文，覆盖所有完整检索词的命中及有效图事实继续保留，即使向量得分较低；完整词判断保留单字数字和长查询的末尾条件。

宽泛主题查询同时得到文件名和正文支持（两者各覆盖至少一半有效查询字符）时，可独立通过关键词召回，不依赖向量得分或是否进入向量候选。例如“项目管理”可找到标题为“项目安排A/B.txt”、正文描述项目评审的两份材料。查询明确提及已发布实体的完整名称或别名时，也可用其名称及别名召回正文；这种文字命中标记为 `keyword`，只有实际关联图事实来源才标记 `graph`。候选先按正文完整命中、结合文件名完整命中、明确实体/主题支持、其他局部匹配排序，同档次按文档交错取片段；排序与最终筛选共用英文词边界。

没有上述独立支持时，局部匹配覆盖至少一半查询字符可将原始向量门槛降低 `0.10`（默认 `0.40`），以保留“评审时间”匹配“周五评审”等短查询；更少覆盖仍须达到完整向量门槛。中文覆盖按匹配的二字片段计数，重叠位置不重复计数；英文按完整词匹配。“资料、信息、文档、documents”等泛词不贡献覆盖度，但正常完整词检索不受影响。上述判断都在加分前执行。同义表达不要求包含原检索词，可凭达到门槛的语义得分召回。

同文档版本、同实体类型的普通重复文本在截取数量前去重，仅忽略首尾空白，保留最高分条目的原始定位；正文内部换行和制表符不压平。带图谱命中的条目各自保留来源，不与相同文字的普通结果合并；不同文档、金额、日期或否定表述不合并。相关结果不足时返回较少结果或空结果。

复用已有 `SEARCH_VECTOR_MIN_SCORE`（范围 0–1），没有新增开关或 LLM 调用。如果实例显式配置了旧值 `0.40`，它会继续覆盖默认值，可按验证结果调整为 `0.50`；更换模型仍需按实际材料校准，此门槛不能保证所有问题的相关性。修改后重启即可生效，无需重建索引。页面“检索得分”为排序值，包含多通道加分时不等于原始余弦得分，且不代表相关性的概率。

2026-10-06 相关性修复通过 63 项检索、配置、MCP 和脱敏测试，以及前端构建。使用现有 v15 的 44 个向量块在独立数据库和 Qdrant 副本中复测：请求上限 50 时，“半人马”从 44 条收敛到相关 PDF 的 21 条，截图中的测试用例、相似资料及功能拆解均不再返回；两个无关查询均返回空结果，同义表述仍保留纯向量命中。验证未重新向量化材料、未修改运行中的材料库，结果保存于 `reports/search-relevance-validation.json`。

材料处理与检索复审修复：材料筛选同时约束图谱证据及入口实体；关键词候选先按完整匹配排序再截取。校对保存后独立安排索引更新，即使后续 LLM 抽取失败也不阻塞正文检索。用户取消的抽取/发布任务在重启后保持取消，发布提交前后均核对取消标记及材料版本。

删除材料会立即将其排除在检索结果之外，并直接安排后台索引更新，不受知识自动抽取开关影响。清理任务会物理删除该材料的本地数据和外部图/向量记录，并保留其他现存材料仍在使用的相同文本向量；删除后重传同一份唯一材料需要重新解析、生成向量并检测敏感信息。连续删除只保留当前语料的有效构建任务；最后一份正文删除后活动索引停用。旧版逻辑删除留下的材料会在服务启动时补排物理清理任务。

已经建立索引或有索引构建中的工作空间，会在材料解析完成、校对保存及服务启动时维护当前索引，即使关闭知识自动抽取；这不会启用知识抽取。删除全部材料后再次导入也继续维护索引。没有索引且关闭自动流水线的工作空间仍由用户首次创建索引。

索引任务重试会重新核对当前材料和 Embedding 配置：有效任务或活动索引已存在时直接复用，旧任务标出接替它的索引任务；快照未变的失败任务保留原任务 ID 和历史重试；材料或模型已变则安排当前版本，不再反复重试旧快照。材料库为空时明确提示无需重试。OpenAI/Ollama Embedding 冷启动优先读取相同配置的已完成索引维度；无记录时使用首个正文块确定维度并复用该向量，后续响应维度不一致时拒绝写入混合向量缓存。

后续复审补充：关系数量限制应用于所选材料的有效已发布事实；本地先选定事实，Neo4j 查询也在 `LIMIT` 前限制材料和事实 ID。图谱交付中的名称、别名、属性和证据读取本地已确认发布记录，Neo4j 提供关系存在性校验。若取消发生在远端提交后、本地确认前，远端残留写入不会覆盖页面、检索或 MCP 交付内容；此保证不等同于回滚已经提交的 Neo4j 事务，远端投影可用已有图重建工具对账恢复。

工作块版本更新为 `semantic-work-v5-trailing-headings`，保留文末标题及其来源映射，页末标题也不会附着到下一页正文。旧向量索引需更新才能应用新切分；个人自动模式启动后会安排索引更新，亦可在页面点击“更新索引”。已有缓存的相同文本向量会被复用；既有已发布知识不会因切分版本更新自动重抽取，新上传或校对后的材料按新切分进行抽取。

主要 API：`GET/POST /api/search/indexes` 和 `POST /api/search`。执行 I5 回归；默认使用随机隔离工作区调用当前配置的真实 Embedding API 和 Neo4j，`-SkipRemote` 只执行离线回归：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Test-I5.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\Test-I5.ps1 -SkipRemote
```

### I5 页面手工测试

I5 完成后即可在页面测试完整检索闭环。先按 I4 流程发布一份知识，再进入“证据检索”创建索引；等待任务中心显示完成后，用材料中的实体名和自然问题检索，核对 `vector`、`keyword`、`graph` 通道以及原件/来源页跳转。随后校对或删除该材料，确认旧内容立即不再出现；重新发布知识并更新索引后，确认新正文可以检索。切换 Embedding 配置并重启应用时，页面应提示旧索引不兼容，不能混用。

真实验收结果见 [I5 验收记录](docs/I5-验收记录.md)。

## I6 运维与独立交付

使用 `Start-Semantica.ps1` 一键提供生产构建页面和 API。应用停止后，`Diagnose-Semantica.ps1` 对账 SQLite、文件、Qdrant、图重建清单、模型 manifest 和磁盘空间；`Backup-Semantica.ps1` 创建带逐文件 SHA-256 和 HMAC-SHA256 认证的一致性归档；`Restore-Semantica.ps1 -Confirm` 在替换数据前认证归档、校验 SQLite，并在恢复失败时回滚。备份、验证和恢复使用 `.env` 中独立的 `BACKUP_HMAC_KEY`，该密钥不进入归档。远程图可通过 `Rebuild-Graph-Semantica.ps1 -Confirm` 从本地有效发布证据重建。

访问日志轮转保存于 `data/logs`，不记录查询参数、正文或异常消息。默认保留 256 MiB 磁盘余量，空间不足时拒绝上传；未完成上传按保留时间清理。完整流程和风险边界见 [备份、恢复与运维](docs/备份恢复与运维.md)，验收结论见 [I6 验收记录](docs/I6-验收记录.md)。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Test-I6.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\Test-I6.ps1 -SkipRemote
```

## I7 个人自动知识流水线与 MCP

生产启动默认启用个人模式。上传材料并解析成功后，单槽持久任务会继续完成知识抽取、本体校验、Neo4j 发布和检索索引更新，不再要求逐条审核候选、手工发布知识或手工更新索引。系统管理的个人本体覆盖人物、组织、地点、事件、概念、材料、产品、功能、技术和日期。I7 最初将未声明类型映射到 `CONCEPT`/`RELATED_TO`；当前 I8 规则已经取代该行为，详见下一节。页面主导航保留“材料与校对”“知识网络”“证据检索”，本体及候选数据仍保存在数据库和 API 中，供后续知识修改功能使用。

`Start-Semantica.ps1` 同时启动页面/API 和 MCP。页面/API 继续监听本机 `127.0.0.1:8090`；MCP 默认监听所有网卡的 `8091` 端口，Streamable HTTP 地址为：

```text
http://<运行 Semantica 的电脑 IP>:8091/mcp
```

当前 standalone 部署默认提供九个工具：`search_knowledge`、`get_evidence`、`retrieval_status`、`confirm_sensitive_search` 提供检索与受保护证据交付；`discover_reasoning_skills` 发现方法，`prepare_reasoning` 获取固定版本的方法正文与引用目录，`get_reasoning_reference` 按引用 ID 分页读取附属文档；`read_reasoning_document` 读取固定材料正文，`get_reasoning_coverage` 查看已交付范围。准备 ID 是后台版本关联，不要求用户进入页面操作。ZIP 相对路径在引用标题中返回，Agent 根据路径找到引用 ID 再读取；`package-entry` 对应原始 SKILL.md。Agent 根据方法直接分析并在当前对话中输出，不得宣称经过服务端事实确认或规则认证。已移除候选、计算、结果保存的六个工具，客户端更新后应重新发现工具列表。MCP 和推理方法默认开启，不需要逐功能添加启用参数。旧部署若显式配置 `REASONING_SKILLS_ENABLED=false`，移除该项后重启即可恢复默认工具。默认工作空间为 `default`。MCP 按当前个人使用需求不使用 API Key，也不增加 Host、Origin、来源网络或调用额度限制；能连接该端口的客户端即可调用。`MCP_HOST` 可直接配置为 `0.0.0.0`，不要求改为回环地址。

```dotenv
KNOWLEDGE_AUTO_PIPELINE=true
MCP_ENABLED=true
MCP_HOST=0.0.0.0
MCP_PORT=8091
MCP_PATH=/mcp
MCP_REQUEST_TIMEOUT_SECONDS=180
MCP_ELICITATION_TIMEOUT_SECONDS=15
```

常见 Agent 的 MCP 配置只需填写 URL，例如：

```json
{
  "mcpServers": {
    "semantica": {
      "url": "http://192.168.1.20:8091/mcp"
    }
  }
}
```

完整回归入口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Test-I7.ps1
```

验收结论见 [I7 验收记录](docs/I7-验收记录.md)。

## I8 语义切块与高精度知识图

所有已支持材料统一使用结构感知工作块：TXT、Markdown、DOCX、文本/扫描 PDF、PNG/JPEG OCR 和 WAV/MP3/M4A/FLAC 转写都先保留原始来源片段，再按相邻语义合并供知识抽取和向量化使用。来源片段仍在材料页逐条展示和校对，不等同于一个向量块。切块参数可通过以下配置调整：

```dotenv
KNOWLEDGE_CHUNK_TARGET_CHARS=1800
KNOWLEDGE_CHUNK_MAX_CHARS=2200
KNOWLEDGE_CHUNK_OVERLAP_CHARS=250
EMBEDDING_CHUNK_TARGET_TOKENS=384
EMBEDDING_CHUNK_MAX_TOKENS=480
EMBEDDING_CHUNK_OVERLAP_TOKENS=64
```

个人知识图采用高精度策略。模型提示要求只返回少量、长期可复用且明确陈述的实体和事实；共现、相似主题、标题/字段名、优先级和普通名词不会仅凭出现就建立关系。未声明实体类型和关系直接进入拒绝审计，不再转换成 `CONCEPT` 或 `RELATED_TO`；无有效受约束关系的实体也不发布到图中。被拒绝的内容仍存在于正文和向量/关键词检索中，因此不会令材料“搜不到”，只是不会产生低质量图扩展通道。

完整回归入口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Test-I8.ps1
```

验收结论见 [I8 验收记录](docs/I8-验收记录.md)。

## LLM 双配置、显式切换

`.env` 中保留外部 OpenAI 兼容 API 与已有 Ollama 两套初始配置。运行后可在“脱敏设置 → 知识识别与脱敏 LLM”填写 OpenAI 兼容接口或 Ollama 的连接信息，先“测试连接”，再“保存 LLM 连接”。保存值写入本地 `data/llm-connection.json`（若自定义 `DATA_DIR` 则位于该目录），优先于 `.env`，重启后仍生效；该文件包含 API Key。从 I10 起，数据备份会包含已存在的此配置文件，备份归档也需妥善保管；旧备份仍需单独保存该文件。读取 API 和页面只显示密钥是否已配置；密钥输入留空会沿用已保存值。保存后新知识抽取和语义脱敏检测使用同一连接，已运行抽取保持配置快照，检测签名变化时按当前交付内容安排重检。只验证、调用选中的服务，失败不会自动回退到另一家。`LLM_PROVIDER` 是本项目的显式选择器；抽取与脱敏通过项目 HTTP 适配器和结构化结果校验调用选定模型。Ollama 不依赖可选的 `ollama` Python 包，也不会携带外部 API Key。

两种提供方的知识抽取上限和抽取/脱敏提示词保存在 [LLM 模板配置](docs/LLM模板与参数配置.md) 中，默认文件为 `config/llm_profiles.json`；更改后重启服务。连接、思考模式和 token 预算继续使用上述页面与 `.env` 配置。

先使用外部 API 时填写：

```dotenv
LLM_PROVIDER=openai_compatible
OPENAI_BASE_URL=https://你的服务地址/v1
OPENAI_API_KEY=你的服务密钥
OPENAI_MODEL=服务商提供的模型名称
MODEL_TIMEOUT_SECONDS=180
```

`OPENAI_BASE_URL` 是服务商要求的 API 基础路径，不固定要求以 `/v1` 结尾，但不能加 `/chat/completions` 或 `/responses`。本适配针对 Chat Completions 协议，不支持仅提供 Responses API 的端点。外部 API 必须使用 HTTPS（本机回环测试除外）。模型名按服务商原样填写，不加提供商前缀。

切换到已有 Ollama 时，仅修改选择器并确认其配置：

```dotenv
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://你的Ollama地址:11434
OLLAMA_MODEL=已安装的聊天模型完整名称
```

Ollama 地址不能包含 `/api` 或 `/v1`。HTTP 仅建议用于可信内网/VPN；本适配不支持需要额外鉴权头的 Ollama 网关。外部 API Key 不会发送给 Ollama。未选中的另一套配置可以保留占位值。如果尚未通过页面保存，可修改 `.env` 后重启；页面一旦保存，后续应在页面修改或移除本地 `llm-connection.json` 后重启。若 Embedding 使用 Ollama，聊天与 Embedding 仍共用 Ollama 地址。

Embedding 独立选择，不随聊天服务自动切换：

- `EMBEDDING_PROVIDER=none`：暂不启用；不代表向量检索就绪。
- `EMBEDDING_PROVIDER=openai_compatible`：填写 `EMBEDDING_BASE_URL`、`EMBEDDING_API_KEY`、`EMBEDDING_MODEL`，服务需支持 `/embeddings`。即使与聊天同服务，也显式填写，不自动继承密钥。
- `EMBEDDING_PROVIDER=ollama`：使用已有 `OLLAMA_BASE_URL` 和 `OLLAMA_EMBED_MODEL`。
- `EMBEDDING_PROVIDER=local`：使用项目内 BGE 模型，不发送文本到外部服务。

例如可以选择外部 LLM 抽取，同时用已有 Ollama 生成向量。切换嵌入模型时应重新验证维度并重建相关索引，不能混用不同模型的材料与查询向量。

在开发终端先进行不联网的格式检查：

```powershell
.\.venv\Scripts\python.exe check_environment.py --config-only
.\.venv\Scripts\python.exe -m unittest -v test_model_api
```

未填写当前选中的服务配置时，`--config-only` 会失败，这是预期行为。单元测试使用模拟响应，不读取真实密钥、不访问外部 API，也不产生调用费用。

## 连接已有服务

`.env` 初始为占位配置，请在本机编辑，不在聊天中发送密码。

- 远程 Neo4j：`111.231.59.249:7687`。I0 已通过隔离探针验证认证、写入、读取和即时清理；业务图模型与长期数据仍未验收。
- 默认使用 SSH 隧道，`.env` 的 URI 为 `bolt://127.0.0.1:17687`。
- 按上节配置选中的 LLM 和 Embedding 服务；不重复部署 Ollama。
- Qdrant 使用 `data/qdrant` 本地目录，不启动服务；同一路径只允许一个客户端进程持有。

另开终端建立隧道（替换为实际 SSH 账号，首次连接核实服务器主机密钥）：

```powershell
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 127.0.0.1:17687:127.0.0.1:7687 root@111.231.59.249
```

隧道需要远端监听 `127.0.0.1:7687` 并允许 SSH 转发；保持窗口打开。公网未加密 Bolt 地址不用于默认密码登录。不更改远端监听或安全组。

填好配置、明确允许服务测试后，在开发终端运行：

```powershell
.\.venv\Scripts\python.exe check_environment.py
.\.venv\Scripts\python.exe check_environment.py --chat
.\.venv\Scripts\python.exe check_environment.py --embedding
.\.venv\Scripts\python.exe check_environment.py --models
.\.venv\Scripts\python.exe check_environment.py --extract
```

默认基础检查只读远程数据库，可能初始化本地 Qdrant 元数据，对模型只校验配置格式，不访问模型列表。带 `--chat`、`--embedding`、`--models` 或 `--extract` 的命令只进行模型相关检查，不连接 Neo4j 或本地向量库，但会发送合成文本并触发推理，外部 API 可能计费。`--models` 在 `EMBEDDING_PROVIDER=none` 时明确跳过嵌入测试；显式使用 `--embedding` 则要求已选择并配置嵌入服务。

检查通过不等于完整 GraphRAG 验收。本地 Qdrant 与 Semantica 原生向量封装的适配、ContextGraph 与 GraphStore 的业务衔接仍需后续迭代开发，不能假定自动同步。当前选中的外部 LLM 已通过真实合成抽取，Neo4j 及 Semantica GraphStore 已通过隔离写读清理；Ollama 仍只完成无密钥泄漏的离线适配测试。导入真实材料前确认服务商的数据处理政策。

## I9：检索交付脱敏

工作台新增“脱敏设置”。未保存设置的工作空间默认开启交付脱敏和 LLM 语义敏感识别，已保存的开关状态保持不变；这两个开关修改后自动保存，切换页面或重启后保留选择。规则编辑通过“保存脱敏设置”提交，可按工作空间使用九条内置规则（电话号码、邮箱、身份证号、密钥、人名、详细地址、公司名称、合同名称、银行卡号）和最多 30 条自定义语义规则。规则可选自动脱敏、拒绝交付或交互确认；交互确认可单独设置是否允许用户领取原文。密钥规则始终启用并拒绝交付。内置识别器固定，遮盖强度不能弱于默认值；自定义规则至少要有识别说明和一条正例，也可填写反例。重叠命中按更严格的方式合并遮盖。设置页将规则编辑、容量提示、检测状态和脱敏测试分开展示。

语义检测直接复用知识抽取当前选中的 `LLM_PROVIDER`、模型、地址和密钥，可在同一设置页配置 OpenAI 兼容接口或 Ollama。规则保存后自动扫描当前索引、实体和图谱证据；后续索引或知识图谱更新也会触发扫描。切换当前 LLM 的服务地址或模型后，检测缓存与扫描状态随之失效并重新扫描。模型检测失败时，相应字段不会以原文返回，可在设置页查看任务并重试。

规则变动的生效与扫描行为：

- 新增、停用、重新启用和删除自定义规则都需要点击“保存脱敏设置”；只改表单不会影响交付。内置规则可停用但不可删除，密钥规则不可停用。
- 新增/删除规则、启停单条规则、修改识别说明/正例/反例或语义规则名称，会改变检测版本。系统为当前可交付内容安排扫描，合并过时的排队扫描；运行中的旧扫描在检查到版本变化后取消，记录 `DETECTOR_CHANGED`，不提交过时结果。没有可用检索索引时等待索引建立。
- 检测缓存按“工作空间 + 检测版本 + 完整文本”复用。识别规则变化后，需要按新规则重新检测当前内容，尚未按新规则检测的语义字段暂缓交付；此时不是仅扫描新增文件。普通新增材料而规则未变时，旧文本检测结果仍可复用，重复文本只检测一次。
- 只修改替换文字、遮盖方式、交付方式或是否允许确认原文，复用检测缓存，按新交付策略即时处理；已完成且内容未变的扫描不会重复创建。已经失败或取消的当前扫描在保存时可被重新排队。
- 每次成功保存都会更新设置版本，旧的 MCP/页面交付确认令牌随之失效，需重新检索。规则修改不重建向量索引、不重跑知识抽取，也不改写原始材料。
- 检测版本 v5 修复了“语义规则改名仍复用旧缓存”的问题。升级后旧版本缓存因缺少当时规则名称而不能安全复用，将在启用脱敏且存在索引时重新检测一次；新版本检测结果会持久保存，后续设置和内容未变的重启会复用结果。

`POST /api/search`、`GET /api/graph/neighborhood` 和 `GET /api/evidence/{id}` 共用脱敏规则。MCP 的 `search_knowledge` 默认使用 `delivery_mode="confirm"`：已检测且可交互的敏感命中先以脱敏版返回，用户可选择查看原文或继续使用脱敏内容；拒绝交付的命中不会返回，禁止确认原文的命中只返回脱敏版，检测尚未完成的正文仍暂扣。支持 MCP Elicitation 的客户端会收到“查看原文 / 使用脱敏内容”选择；选择原文后服务消费一次性、5 分钟有效的令牌交付原文，选择脱敏版或取消时只返回脱敏版。不支持 Elicitation 或弹窗不可用时，工具返回 `next_action="confirmation_required"` 和脱敏结果，Agent 须先在对话中取得用户明确同意，再调用 `confirm_sensitive_search(token, choice="original")`；用户选择脱敏版时直接使用已有结果。`delivery_mode="masked"` 可跳过确认，仅交付脱敏版。设置 API 为 `GET/POST /api/sensitive/settings`，测试 API 为 `POST /api/sensitive/preview`。MCP 仍无 Key 鉴权，也没有增加无 Key 的额外边界限制。

MCP 选择表单使用单个 `value` 枚举字段，与 sensitive-delivery-sidecar-template 中 FastMCP `response_type=[...]` 的协议形状一致。Trae Work 等外部 Agent 是否显示原生选择框取决于其 MCP Elicitation 能力；未显示时，`confirmation.options` 与 `confirmation.message` 明确给出“1. 使用脱敏内容；2. 查看原文”，`confirmation.fallback_reason` 标出回退原因。Agent 应暂停等待用户选择，不得将这两项改写成只提示“回复查看原文”。

`get_evidence` 现在也支持相同选择流程：默认返回已检测的脱敏摘录及定位信息，允许原文确认时附带证据专用令牌，交由同一 `confirm_sensitive_search` 工具确认，返回 `{ "evidence": {...} }`。令牌在材料撤回、校对或规则变化后失效。未完成检测不返回原文；检测失败/取消提示重试检测，规则拒绝交付明确标为 `blocked`，不再误提示重新扫描。

MCP 原生确认通过 `sensitive.confirmation_snapshot` 绑定交付内容版本、规则版本、检测配置、索引和选中的结果。同一证据原文变化但替换标记相同时，也不能沿用旧选择：客户端续调会重新询问。相同版本的预览只询问一次。若后端未提供版本绑定，MCP 回退为对话确认并保留一次性令牌，不自动交付原文。升级后端与 MCP 后生效，无需修改外部 Agent 的工具参数。

当前脱敏作用于检索、图谱和证据的交付；启用后检索结果不附带原件或预览链接，即使当前片段没有命中敏感规则。原始材料及人工校对页面和相应原件接口仍显示原文；知识抽取与外部 Embedding 仍使用原文。交付脱敏不是原始材料接口的访问控制。若需在发送至外部模型前脱敏，需要另做上游处理设计。数据库 schema 升至 8；恢复旧 schema 备份仍须遵循同版本恢复流程。

## 范围与资料

知识提取、本体和检索为研发范围，不包含知识卡片/摘要。Neo4j 为图事实存储，向量索引可重建；材料和任务状态保存在本地 `data/`。大规模数据和并发需要另行压测。

业务研发与独立运行的当前方案见 [开发迭代指引](docs/开发迭代指引.md)，无需访问旧项目文档即可按阶段推进。

I10 已实现增量脱敏、多栏正文整理、Ollama 高级预算与策略、文本检索独立就绪。设置页的“高级处理设置”默认分步抽取、单并发；联合抽取为显式选项。正文默认显示整理后的段落，可切换来源行校对。图谱处理期间可以先检索已索引正文；未检测命中返回待检测状态和重试提示，不占用页面请求等待 LLM。

开发范围见 [I10 方案](docs/I10-文件处理性能与版面重建迭代方案.md)，验证结果及手工测试步骤见 [I10 验收记录](docs/I10-验收记录.md)。本地约 2B 模型真实质量与性能测试按用户安排留待后续，当前没有据此建议开启联合抽取。

I11 修复脱敏重试重复入队，按当前交付版本复用扫描和精确文本缓存。任务中心分别显示覆盖字段数、缓存复用和本轮新增检测文本数，执行统计保留历史轮次。稀疏 PDF 页可按预算组合用于知识抽取，原始位置和向量块分页仍保留；默认继续分步抽取、单并发。新 LLM 配置默认关闭思考模式；已有显式配置保持原值，不支持关闭的接口可选择模型默认模式。高级设置支持 OpenAI 兼容接口的 thinking 控制和可选 2–4 批次并发。详见 [I11 方案](docs/I11-知识抽取提速改造方案.md) 与 [验收记录](docs/I11-验收记录.md)。I11 升级 SQLite 至 schema 10，更新前按部署文档备份，回退旧代码时使用对应 schema 数据。

- [Semantica 0.7.0](https://pypi.org/project/semantica/0.7.0/)
- [Qdrant Local Mode](https://github.com/qdrant/qdrant-client#local-mode)
- [Neo4j 连接安全](https://neo4j.com/docs/python-manual/current/connect-advanced/)
