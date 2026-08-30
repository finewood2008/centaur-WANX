# 半人马AI-万象 · CentaurAI-WanX

超级个体的助手创造器。你跟一个 AI 产品经理做选择题，右边一份正式的需求文档被逐节写出来；确认后全自动造出一个能跑的助手——能单独跑活，也能跟你多轮对话。

## 这是什么

面向超级个体（＝半人马个人＝OPC，一人公司）。**全程只做选择题**，看过去很专业，但你不需要理解任何专业术语。

核心链路：**产品经理对话 → PRDDraft（唯一事实源）→ AppSpec → 确定性编译 → agent preset ＋ SKILL.md → 万象自己的运行区**

造出来的助手不是个聊天机器人，是**一个替你干活的工人**，而且**长着自己的工作台**：访谈说「帮我整理待办」，打开它就是清单工作台；说「每天给我简报」，打开就是简报阅读台——界面形态由需求编译出来（组件蓝图，不是生成代码）。你把资料交给它、按「让它跑一次」，产出以工具的形态立在主区；跑得不对就**调教它**——说一句「这里不对，以后要…」，它的工作手册被修订成新版本，可对比、可回滚，下次跑立即生效。

## 在线试一下

[![在 Codespaces 里打开](https://github.com/codespaces/badge.svg)](https://codespaces.new/finewood2008/centaur-WANX?ref=test%2Fjob-mode-ui&quickstart=1)

> 徽章现在指向 `test/job-mode-ui` 分支（demo 就在这个分支上）。合进 `main` 之后
> 把链接里的 `?ref=…` 去掉即可。

点上面那个按钮，GitHub 会给你开一个自己的容器，装好依赖、铺好一个**跑过一次的示例助手**、
把服务起起来，端口自动转发。等一两分钟，浏览器里就能看到界面。

**不用配 key 就能看的**：

- 侧边栏里的「会议待办整理助手」——点进去是它的主页
- **它会做的事**：5 步工作流程，那是访谈里一句句问出来的
- **它的资料夹**：一份会议记录，加上它自己跑完写下的东西
- **最近的产出**：点开是一份真的待办清单，带负责人、截止时间、⚠️ 待确认项
- **看需求文档**：11 节的 `prd.md`，那 10 轮对话的投影

**想自己造一个助手、或者按「让它跑一次」**，需要填一把 DeepSeek 的 key
（[platform.deepseek.com](https://platform.deepseek.com) 申请，形如 `sk-…`）。
填在界面第一屏，存在容器里的 `~/.config/wanxiang/config.json`，权限 `0600`，
容器销毁就没了。也可以走 `export DEEPSEEK_API_KEY=sk-…` 再 `npm start`。

示例助手是怎么来的、为什么它不是手写的样板，见 [`examples/README.md`](examples/README.md)。

### 为什么没有一个公开的共享 demo

**服务端没有任何认证**，而每次「让它跑一次」和每轮对话都在烧真金白银的 token——
一个人人可访问的公开实例等于把你的 key 开放给匿名访客。

Codespaces 恰好解掉这一条：一人一个容器，用自己的 key，跑完就销毁。
这不是退而求其次，对这个产品来说它就是对的形态。

## 架构

```
运行内核（DSH，只做执行）→ 知君插件＋底座（记忆）→ 万象（唯一的产品面）→ 用户助手（preset）
```

万象是唯一对外的产品；DSH（DeepSeek Harness）退到幕后只做执行内核——会话、agent、
工具注册表、沙箱、持久化。启动时 boot 一条 `wanxiang` profile：**`dsh-base +
@centaur/wanxiang` 两层**（见 `packages/wanxiang-bundle/`），**一个进程、一个端口**。
界面挂在 `/`、API 挂在 `/wanx/*`，其余路径一律 404——没有第二个界面，没有内核自己的
SPA、设置页或品牌位。

「让它跑一次」和「跟它聊聊」在**同一个运行时**上建会话：同一个 agent 平面、同一套
preset 语义。哪个助手、看哪个目录，都是**建会话那一刻写进会话头的显式参数**
（`agentPreset` + `cwd`），此后不可变——不存在任何「全局当前助手」，切换助手 =
到那个助手名下开新会话，天然不串台。两类会话按 id 前缀分家：

- `wanx-run-…` 一次性。每次跑都开全新会话——同一个助手、同样的资料，行为不该因为
  「这是第几次跑」而变，跟编译器的确定性是同一条原则。产出进 `runs/` 台账。
- `wanx-chat-…` 长活。上下文持续、可打断插话、断线可回放，会话日志本身就是记录。

助手的能力由 preset 说了算：万象的组合层把 host 平面所有面向模型的工具都关掉了，
preset 里没列的工具助手就真的没有。万象编译出的 preset 带一个固定基线（读写文件、
检索、待办、工作手册），**刻意不给 shell**——`capabilities` 里点了联网类能力才挂
`tool-web`，选了 browse/api_call 才放开 fetch。访谈里的选择从这里开始是真话，不再是
文档字段。越界写入被确定性拒绝（审批策略写死 `never`）：助手只能在自己的资料夹里干活。

## 功能特性

- **AI 产品经理**：每轮三拍——回读你的意思 → 说明写进了第几节 → 提问。流式逐字输出，上限 20 轮，随时可叫停，也随时可以不选、自己打字。
- **每轮都给选择题**，选项带「选它意味着什么」和「写进文档会变成哪句话」。模型给不出合法选项时由代码补一组，这条不靠模型自觉。
- **对话即 PRD**：右栏是一份 11 节双语的正式需求文档，边聊边写，没聊到的章节留骨架占位；背景与问题 / 目标用户 / 验收标准由产品经理归纳并明确标注。可导出 `prd.md`，浏览器打印即 PDF。
- **确定性编译**：同一 AppSpec 永远产出同一应用包（persona 全文、插件清单、技能文件）。
- **自动开发**：工作流程编译成真正的 `SKILL.md` 装进助手的 workspace，它每次干活照着走——不只是一段人格提示词。
- **给它资料**：把会议记录、邮件、随手记的东西粘进去，存在助手自己的工作目录里。它只看得见你放进来的东西——没有资料，它跑出来的就是一份空的，界面会直说这一点。
- **让它跑一次**：一个按钮。进度是白话（「正在读「八月客户往来.md」」），界面上不出现工具名。跑完的交付物存进 `runs/`，能复制、能打印成 PDF、能随时翻回来。
- **跟它聊聊**：万象自己的多轮对话界面。逐字流式、工具卡片折叠可展开、随时「停下」、运行中发消息就是插话；每个助手名下多条对话可切换，关掉页面回来接着聊，历史完整回放。对话里也能一键「让它跑一次」，产出以卡片落进对话流。
- **专属工作台**：每个助手的主页由界面蓝图（AppSpec 的纯函数投影，现算不落盘）拼装——主区按交付物形态呈现最新产出（清单 / 表格 / 简报三型），侧区是操作、资料夹、可调的、定时、工作手册、历史。空态即引导。
- **调教循环**：结果页、对话、工作台三处都能说「这里不对」。反馈交给模型修订工作手册（只动被指到的条目），回写规格并全量重编译——手册与人格永远一致；版本账本可对比可回滚（app.yml 是唯一当前态权威，账本只是历史，永不撒谎）。下次跑立即生效；正在聊的对话，新开一条才用新手册。
- **可调的（params）做真**：访谈里声明的参数在工作台上有了表单，存好的值注入每次运行（含定时跑）——不再是文档字段。
- **技能按助手隔离**：每个助手的工作手册装在它自己的 `workspace/.dsh/skills/`，共享根保持空，助手之间互相看不见。
- **定时**：助手主页上把「到点自动跑」打开（每小时 / 每天 / 每周几点），万象开着它就自己跑，产出照常进「最近的产出」。宕机漏掉的只补最新一次，绝不补跑风暴。
- **外部能力（MCP）**：侧栏「外部能力」页接上一个 MCP server，所有助手都多一批工具（界面上显示为「正在使用外部能力：<server>」），改动热生效不用重启。
- **桌面应用 / Web / CLI 三个入口**。

## 桌面应用（推荐）

桌面上有 **半人马AI-万象** 的启动器，双击即可。它会按需拉起服务、等就绪再显示界面，关窗时收掉自己起的进程。

**它认得出端口上的旧实例。** `/health` 带一个界面契约版本 `ui`；探测到端口上跑着旧版万象时**拒绝复用**（复用的话你看到的还是旧界面），并在窗口里给一个「收掉旧的，用新版打开」的按钮——只对 `cmdline` 能确认是万象服务的进程动手，认不出的一律不碰。

出问题看 `~/.cache/wanxiang/desktop.log`：双击启动没有终端，所有关键步骤都落在那里。

```sh
npm run desktop          # 或者从命令行起同一个应用
npm run icon             # 从 public/static/logo.png 重新生成各尺寸图标（需要图形环境）
```

品牌图标是半人马 logo。源图 `public/static/logo.png`，`npm run icon` 用 Electron 的渲染器
把它切成 `electron/icon.png`（512，桌面与窗口）、`public/static/logo-256.png`（界面）、
`public/static/favicon.png`（标签页）。本机没有 `convert`/`rsvg-convert`，这是不引新依赖的做法。

> Electron 的 `chrome-sandbox` 在本机不是 `root:4755`，启动器带了 `--no-sandbox`。
> 想开回沙箱，跑一次：
> `sudo chown root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox`

## 快速开始

```sh
npm install

# 跑测试 + typecheck
npm test
npm run typecheck

# 启动（单进程单端口：界面、API、对话都在这里）
export DEEPSEEK_API_KEY=你的key
WANXIANG_PORT=8788 npm start
# 打开 http://127.0.0.1:8788

# CLI 生成应用（--no-memory：知君记忆插件未实现前默认）
npx tsx bin/wanxiang.ts "帮我做一个跟进客户的助手" --no-memory
```

## 目录结构

```
src/
  config.ts   # 本地配置（模型 key），用户目录、0600、仓库之外
  appspec/    # AppSpec schema + 校验器 + slug（中文名→英文 preset id）
  compiler/   # 确定性编译器（persona / tools / compile / serialize / skill）
  definer/    # 产品经理与定义器（draft / interviewer / prompt / normalize / define / deepseek）
  prd/        # 11 节文档结构（sections）与确定性渲染（render）
  runtime/    # agent-session（会话工厂）/ chat-events（事件投影）/ tool-view（工具白话）
              # / chat-pool（长活对话池）/ run-agent（跑一次）/ dsh-runtime（探针用）
  pipeline.ts # 编排层（runPipeline / runFinalize）
  cli.ts      # CLI
  runs.ts     # 产出存储（每次跑的元数据 + 交付物落盘、回看）
  materials.ts# 「资料」——用户交给助手的东西，落在会话 cwd 根下
  boot.ts     # boot wanxiang profile（dsh-base + @centaur/wanxiang），生产与探针共用
  main.ts     # 启动入口：key 同步、遗留清理、自愈、信号处理
  server.ts   # 万象的路由与处理器（含对话链路），由 bundle 挂在内核的 webserver 上
packages/
  wanxiang-bundle/  # @centaur/wanxiang——万象的组合层（整个进程唯一的组合层）
public/       # 前端：index.html + static/app.css + static/app.js（含打印样式）
electron/     # 桌面外壳（main.cjs / launch.sh / icon.svg）
tests/        # 单元测试（vitest）
scripts/      # 图标生成、架构验证探针（probe-*.ts）、示例助手生成
examples/     # 示例助手，npm run seed-demo 装进本机
```

## 模型 key 怎么配

**打开应用第一屏就会让你配**，填一把 key、点「验证并保存」即可——先验证再保存，不会等到聊了一半才发现 key 不能用。之后从侧边栏「模型设置」随时改。

存在 `~/.config/wanxiang/config.json`，权限 `0600`，**在仓库之外**，不会被误提交。造好的助手运行时用的也是这把 key（同进程内直接生效，改完不用重启）。

`DEEPSEEK_API_KEY` 环境变量**优先级更高**：手动 `export` 过的人说了算，配置文件是给双击启动的桌面应用兜底的。两者都有时界面会提示是环境变量在生效，免得你改了设置却不明白为什么没变。

## 环境变量

- `DEEPSEEK_API_KEY`：优先于配置文件；不设也行，用界面配
- `WANXIANG_PORT`：Web 服务端口（默认 8788）
- `WANXIANG_DSH_HOME`：运行内核的数据目录——会话日志、preset、profile（默认项目根目录下的 `.dsh-home`）
- `WANXIANG_APPS`：助手落盘目录（默认 `~/.local/share/wanxiang/apps`）。**必须在 git 仓库之外**，原因见上面「助手的目录长什么样」
- `WANXIANG_CONFIG`：配置文件位置（默认 `~/.config/wanxiang/config.json`）

### 代理（配了代理的机器必看）

`npm start` 里带了两个变量，少一个都跑不起来：

- `NODE_USE_ENV_PROXY=1`：Node 内置 `fetch` 默认**不认** `HTTP(S)_PROXY`，不开这个，DeepSeek 调用直接 DNS 失败。
- `NO_PROXY=localhost,127.0.0.1,::1`：上面那个开关会把**回环请求也塞进代理**，本机探活与桌面外壳都会被误伤。

## 助手的目录长什么样

```
~/.local/share/wanxiang/apps/<slug>/
  app.yml / preset.yml / agent.cordis.yml / memory-binding.yml    应用包
  prd.md / rationale.yml                                          需求文档与判断沉淀
  workspace/              ← 会话的 cwd。助手一睁眼看见的就是这里
    你放的资料.md          ← 「给它资料」存这儿，直接在根下，不用教它去哪翻
    .dsh/skills/<name>/SKILL.md   ← 它的工作手册，按助手隔离
  runs/<YYYYMMDD-HHMMSS-xxxx>/
    run.yml               什么时候跑的、跑了多久、成没成
    output.md             交付物本体
```

**`WANXIANG_APPS` 必须在 git 仓库之外**（默认 `~/.local/share/wanxiang/apps`）。内核发现项目技能时走 `findProjectRoot`——向上找 `.git`，找不到才用 cwd 本身。应用要是落在仓库里，所有助手的 projectRoot 都会解析到仓库根，共享同一个 `<repo>/.dsh/skills`，按助手隔离就没了。

## 已知边界（M0/M1）

- 助手**不能申请越界写入**：审批策略写死 `never`，出了自己的资料夹一律被拒。这是刻意的产品边界，不是缺陷；哪天要放开，得先给对话界面建一条审批应答通道。
- 对话是纯文字的：不支持图片和文件拖放（内核有现成的附件层，留待）。
- 助手的「思考过程」不显示——对最终用户是噪音；要做也是折叠开关，不是默认展开。
- 升级到本版之前的旧对话（旧界面时代的会话）不再出现在「聊过的」里——它们的日志还在 `$DSH_HOME/sessions`，只是没有入口。
- 知君插件（`@centaur/plugin-memory-read/write`）尚未实现，助手当前以兼容变体运行（无记忆绑定）；实现后恢复 `includeCentaurPlugins: true`。在此之前 persona 明说「你能看的东西全在当前工作目录里」——不说清楚的话，助手会真去满文件系统找一个叫 `work_logs` 的东西，实测为此空转 80 秒，最后交回一份空清单
- 定时已兑现，但走的是**运行期设置**（每个应用一份 `schedule.yml`，助手主页上调），不是 AppSpec 字段：spec 是冻结的规格，「几点跑」是用户随时会拧的旋钮。访谈里 `delivery.trigger` 表达意图，定时卡才是兑现处；两者目前没有自动联动（访谈里选了「每周固定跑」不会自动打开定时）
- `memory-binding.yml` 和 `retrieval` 的四个策略目前是声明，没有后端消费它们
- 「资料来源」这一问目前只能由用户自己写——知君的 `memory.list_scopes()` 还没有，给不出真实资料让他勾
- 应用 preset 目录名受内核 `PRESET_ID` 正则约束（小写字母/数字/连字符），中文名经 `slugFromName` 哈希派生

## 接口

万象的接口都在 `/wanx` 下（前缀是历史沿革，保持它前端零改动）。除 `/`、`/health`、`/static` 外的路径一律 404。

对话与生成：

| | |
|---|---|
| `POST /wanx/api/chat` | 产品经理的一轮，SSE 流式 |
| `POST /wanx/api/finalize` | 确认后组装：草稿 → 助手，落盘并装好 |
| `POST /wanx/api/create` | 一句话单发生成（CLI / 测试用，不走访谈） |
| `GET /wanx/api/apps` | 我的助手 |
| `GET /wanx/api/apps/:slug/prd.md` | 导出需求文档 |

助手干活：

| | |
|---|---|
| `POST /wanx/api/apps/:slug/run` | 跑一次，SSE：`step` 白话进度 / `text` 助手的话 / `done` 落盘后的记录 |
| `GET /wanx/api/apps/:slug/runs` | 历史产出，新的在前，带一句话摘要 |
| `GET /wanx/api/apps/:slug/runs/:id` | 某一次的完整交付物 |
| `GET /wanx/api/apps/:slug/materials` | 它能看的资料 |
| `POST /wanx/api/apps/:slug/materials` | 存一份资料（`{name, text}`）或删一份（`{name, remove:true}`） |
| `GET/POST /wanx/api/apps/:slug/schedule` | 定时（`{enabled, every: hour\|day\|week, at, weekday}`），到点自动跑 |
| `POST /wanx/api/apps/:slug/tune` | 调教：`{text, runId?}` → 模型修订手册，铸新版本（或 `changed:false` 指路） |
| `GET /wanx/api/apps/:slug/manual` | 工作手册：当前版本、渲染正文、历史 |
| `POST /wanx/api/apps/:slug/manual/rollback` | 回到某版（`{to}`；历史线性前进，回滚也是追加） |
| `GET/POST /wanx/api/apps/:slug/params` | 参数的运行期取值（跑一次与定时都用它） |
| `GET/POST /wanx/api/mcp` | 外部能力：接上/断开 MCP server，写 profile 补丁层，热生效 |

对话：

| | |
|---|---|
| `POST /wanx/api/apps/:slug/chats` | 新开一条对话 → `{sessionId}` |
| `GET /wanx/api/apps/:slug/chats` | 该助手的历史对话（带标题，新的在前） |
| `GET /wanx/api/chats/:sid/events?from=seq` | SSE：先回放历史再接直播；`hello` / `chat` / `ping` 三种帧 |
| `POST /wanx/api/chats/:sid/say` | 发一句话（运行中＝插话，空闲＝新一轮） |
| `POST /wanx/api/chats/:sid/stop` | 停下当前这轮（以 aborted 收尾，不是失败） |
| `DELETE /wanx/api/chats/:sid` | 收掉活着的 agent（日志保留，随时能再开） |

模型：

| | |
|---|---|
| `GET/POST /wanx/api/settings` | 模型 key，永远只回遮罩形式 |

## 相关文档

- 产品定位与架构：`~/Documents/万象-产品定位与架构PRD.md`
- 应用创建流程：`~/Documents/万象-应用创建流程设计.md`
- AppSpec schema：`~/Documents/万象-AppSpec-Schema.md`
