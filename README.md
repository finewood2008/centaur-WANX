# 半人马AI-万象 · CentaurAI-WanX

超级个体的助手创造器。你跟一个 AI 产品经理做选择题，右边一份正式的需求文档被逐节写出来；确认后全自动基于 DSH 造出一个能跑的助手。

## 这是什么

面向超级个体（＝半人马个人＝OPC，一人公司）。**全程只做选择题**，看过去很专业，但你不需要理解任何专业术语。

核心链路：**产品经理对话 → PRDDraft（唯一事实源）→ AppSpec → 确定性编译 → DSH preset ＋ SKILL.md → 万象自己的运行区**

造出来的助手不是个聊天机器人，是**一个替你干活的工人**：你把资料交给它，按一下「让它跑一次」，它照着工作手册走一遍，交回一份东西。跑过的每一次都存下来，随时能回头看。

## 四层架构

```
DSH（引擎）→ 知君插件＋底座（记忆）→ 万象（平台/元应用）→ 用户应用（DSH preset/bundle）
```

万象是统一对外产品，DSH 是运行核心。**助手跑在万象自己的进程里**——万象经 DSH 的 library API `boot` 一个 headless 运行时，每次跑活儿开一个挂着该助手 preset 的独立会话（`agentPresets.mount` ＋ 独立 cwd），边跑边把进度流式推给界面。界面是万象自己的，不是嵌进来的。

**每次跑都开全新会话。** 同一个助手、同样的资料，行为不该因为「这是第几次跑」而变——跟编译器的确定性是同一条原则。跨次状态将来走记忆绑定，显式声明，不是会话历史的副产品。

DSH 的完整聊天界面保留为**「跟它细聊」**这个次要入口（iframe ＋ 万象统一代理 HTTP/WebSocket，共享同一个 `DSH_HOME`），适合来回商量的场合。那一屏**不做换肤**：DSH 的 CSS 引用了 `--dsw-*` 设计变量，但整个 `@deepseek-ai` 里没有任何地方定义它们，颜色烤死在每次发版都变的哈希类名里。界面上直说那是完整的对话界面——比顶一层随对方发版就碎的皮诚实。

## 功能特性

- **AI 产品经理**：每轮三拍——回读你的意思 → 说明写进了第几节 → 提问。流式逐字输出，上限 20 轮，随时可叫停，也随时可以不选、自己打字。
- **每轮都给选择题**，选项带「选它意味着什么」和「写进文档会变成哪句话」。模型给不出合法选项时由代码补一组，这条不靠模型自觉。
- **对话即 PRD**：右栏是一份 11 节双语的正式需求文档，边聊边写，没聊到的章节留骨架占位；背景与问题 / 目标用户 / 验收标准由产品经理归纳并明确标注。可导出 `prd.md`，浏览器打印即 PDF。
- **确定性编译**：同一 AppSpec 永远产出同一应用包（persona 全文、插件清单、技能文件）。
- **自动开发**：工作流程编译成真正的 `SKILL.md` 装进 DSH，助手每次干活照着走——不只是一段人格提示词。
- **给它资料**：把会议记录、邮件、随手记的东西粘进去，存在助手自己的工作目录里。它只看得见你放进来的东西——没有资料，它跑出来的就是一份空的，界面会直说这一点。
- **让它跑一次**：一个按钮。进度是白话（「正在翻找资料」「正在读材料」），界面上不出现工具名。跑完的交付物存进 `runs/`，能复制、能打印成 PDF、能随时翻回来。
- **技能按助手隔离**：每个助手的工作手册装在它自己的 `workspace/.dsh/skills/`，共享根保持空，助手之间互相看不见。
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

# 跑测试（151 测试 + typecheck）
npm test
npm run typecheck

# 启动 Web 服务（统一的 Agent 创建 + 运行工作区）
export DEEPSEEK_API_KEY=你的key
WANXIANG_PORT=8788 WANXIANG_DSH_PORT=8891 npm start
# 打开 http://127.0.0.1:8788

# CLI 生成应用（--no-memory 生成 DSH 兼容变体，知君插件未实现前默认）
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
  runtime/    # DSH library 运行时适配器（无头调用，用于验证）
  pipeline.ts # 编排层（runPipeline / runFinalize）
  cli.ts      # CLI
  runs.ts     # 产出存储（每次跑的元数据 + 交付物落盘、回看）
  materials.ts# 「资料」——用户交给助手的东西，落在会话 cwd 根下
  server.ts   # Web 服务（SSE 对话 / finalize / 跑一次 / 资料 / 细聊代理）
public/       # 前端：index.html + static/app.css + static/app.js（含打印样式）
electron/     # 桌面外壳（main.cjs / launch.sh / icon.svg）
tests/        # 151 测试
scripts/      # 图标生成、DSH runtime spike
```

## 模型 key 怎么配

**打开应用第一屏就会让你配**，填一把 key、点「验证并保存」即可——先验证再保存，不会等到聊了一半才发现 key 不能用。之后从侧边栏「模型设置」随时改。

存在 `~/.config/wanxiang/config.json`，权限 `0600`，**在仓库之外**，不会被误提交。造好的助手运行时用的也是这把 key（服务会显式传给 DSH 子进程）。

`DEEPSEEK_API_KEY` 环境变量**优先级更高**：手动 `export` 过的人说了算，配置文件是给双击启动的桌面应用兜底的。两者都有时界面会提示是环境变量在生效，免得你改了设置却不明白为什么没变。

## 环境变量

- `DEEPSEEK_API_KEY`：优先于配置文件；不设也行，用界面配
- `WANXIANG_PORT`：Web 服务端口（默认 8787，本机 8787 常被占用建议 8788）
- `WANXIANG_DSH_PORT`：万象启动或复用的 DSH Web 端口（默认 8891）
- `WANXIANG_DSH_HOME`：DSH 与万象共享的 home 目录（默认项目根目录下的 `.dsh-home`）
- `WANXIANG_APPS`：助手落盘目录（默认 `~/.local/share/wanxiang/apps`）。**必须在 git 仓库之外**，原因见上面「助手的目录长什么样」
- `WANXIANG_CONFIG`：配置文件位置（默认 `~/.config/wanxiang/config.json`）

### 代理（配了代理的机器必看）

`npm start` 里带了两个变量，少一个都跑不起来：

- `NODE_USE_ENV_PROXY=1`：Node 内置 `fetch` 默认**不认** `HTTP(S)_PROXY`，不开这个，DeepSeek 调用直接 DNS 失败。
- `NO_PROXY=localhost,127.0.0.1,::1`：上面那个开关会把**回环请求也塞进代理**，导致万象探测不到本机的 DSH，报「DSH Web 启动超时」。

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

**`WANXIANG_APPS` 必须在 git 仓库之外**（默认 `~/.local/share/wanxiang/apps`）。DSH 发现项目技能时走 `findProjectRoot`——向上找 `.git`，找不到才用 cwd 本身。应用要是落在仓库里，所有助手的 projectRoot 都会解析到仓库根，共享同一个 `<repo>/.dsh/skills`，按助手隔离就没了。

## 已知边界（M0/M1）

- 知君插件（`@centaur/plugin-memory-read/write`）尚未实现，助手当前以 DSH 兼容变体运行（无记忆绑定）；实现后恢复 `includeCentaurPlugins: true`。在此之前 persona 明说「你能看的东西全在当前工作目录里」——不说清楚的话，助手会真去满文件系统找一个叫 `work_logs` 的东西，实测为此空转 80 秒，最后交回一份空清单
- `delivery.trigger` 只编译进 persona 的一句话，**没有调度器**：访谈里「每周固定跑一次」这个选项目前兑现不了，只能手动按「让它跑一次」。要 AppSpec v1.1 把 `trigger` 扩成 `manual | schedule | event` 才能落地
- `memory-binding.yml` 和 `retrieval` 的四个策略目前是声明，没有后端消费它们
- 「资料来源」这一问目前只能由用户自己写——知君的 `memory.list_scopes()` 还没有，给不出真实资料让他勾
- 应用 preset 目录名（＝DSH preset id）受 DSH `PRESET_ID` 正则约束（小写字母/数字/连字符），中文名经 `slugFromName` 哈希派生

## 接口

对话与生成：

| | |
|---|---|
| `POST /api/chat` | 产品经理的一轮，SSE 流式 |
| `POST /api/finalize` | 确认后组装：草稿 → 助手，落盘并装好 |
| `POST /api/create` | 一句话单发生成（CLI / 测试用，不走访谈） |
| `GET /api/apps` | 我的助手 |
| `GET /api/apps/:slug/prd.md` | 导出需求文档 |

助手干活：

| | |
|---|---|
| `POST /api/apps/:slug/run` | 跑一次，SSE：`step` 白话进度 / `text` 助手的话 / `done` 落盘后的记录 |
| `GET /api/apps/:slug/runs` | 历史产出，新的在前，带一句话摘要 |
| `GET /api/apps/:slug/runs/:id` | 某一次的完整交付物 |
| `GET /api/apps/:slug/materials` | 它能看的资料 |
| `POST /api/apps/:slug/materials` | 存一份资料（`{name, text}`）或删一份（`{name, remove:true}`） |

模型与细聊：

| | |
|---|---|
| `GET/POST /api/settings` | 模型 key，永远只回遮罩形式 |
| `GET /api/dsh` ＋ `/runtime/*` | 「跟它细聊」——DSH 完整界面，万象统一代理 |

## 相关文档

- 产品定位与架构：`~/Documents/万象-产品定位与架构PRD.md`
- 应用创建流程：`~/Documents/万象-应用创建流程设计.md`
- AppSpec schema：`~/Documents/万象-AppSpec-Schema.md`
