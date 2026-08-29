# 半人马AI-万象 · CentaurAI-WanX

超级个体的助手创造器。你跟一个 AI 产品经理做选择题，右边一份正式的需求文档被逐节写出来；确认后全自动基于 DSH 造出一个能跑的助手。

## 这是什么

面向超级个体（＝半人马个人＝OPC，一人公司）。**全程只做选择题**，看过去很专业，但你不需要理解任何专业术语。

核心链路：**产品经理对话 → PRDDraft（唯一事实源）→ AppSpec → 确定性编译 → DSH preset ＋ SKILL.md → 内嵌运行区**

## 四层架构

```
DSH（引擎）→ 知君插件＋底座（记忆）→ 万象（平台/元应用）→ 用户应用（DSH preset/bundle）
```

万象是统一对外产品，DSH 是运行核心。万象负责助手的定义、生成和导航；运行区把 DSH 原生界面以 **iframe 嵌在万象外壳里**，侧边栏和顶栏保持不动。HTTP 与 WebSocket 都由万象统一代理，两者共享同一个 `DSH_HOME`，用户不需要切换产品或访问第二个地址。

DSH 那半边**不做深度换肤**：它的 CSS 引用了 `--dsw-*` 设计变量，但整个 `@deepseek-ai` 里没有任何地方定义它们，颜色烤死在每次发版都变的哈希类名里。所以运行区内部只做底色、字体和文案对齐。

## 功能特性

- **AI 产品经理**：每轮三拍——回读你的意思 → 说明写进了第几节 → 提问。流式逐字输出，上限 20 轮，随时可叫停，也随时可以不选、自己打字。
- **每轮都给选择题**，选项带「选它意味着什么」和「写进文档会变成哪句话」。模型给不出合法选项时由代码补一组，这条不靠模型自觉。
- **对话即 PRD**：右栏是一份 11 节双语的正式需求文档，边聊边写，没聊到的章节留骨架占位；背景与问题 / 目标用户 / 验收标准由产品经理归纳并明确标注。可导出 `prd.md`，浏览器打印即 PDF。
- **确定性编译**：同一 AppSpec 永远产出同一应用包（persona 全文、插件清单、技能文件）。
- **自动开发**：工作流程编译成真正的 `SKILL.md` 装进 DSH，助手每次干活照着走——不只是一段人格提示词。
- **内嵌运行区**：DSH 以 iframe 嵌在万象外壳里，侧边栏和顶栏保持不动。
- **桌面应用 / Web / CLI 三个入口**。

## 桌面应用（推荐）

桌面上有 **半人马AI-万象** 的启动器，双击即可。它会按需拉起服务、等就绪再显示界面，关窗时收掉自己起的进程。

**它认得出端口上的旧实例。** `/health` 带一个界面契约版本 `ui`；探测到端口上跑着旧版万象时**拒绝复用**（复用的话你看到的还是旧界面），并在窗口里给一个「收掉旧的，用新版打开」的按钮——只对 `cmdline` 能确认是万象服务的进程动手，认不出的一律不碰。

出问题看 `~/.cache/wanxiang/desktop.log`：双击启动没有终端，所有关键步骤都落在那里。

```sh
npm run desktop          # 或者从命令行起同一个应用
npm run icon             # 重新生成 electron/icon.png（需要图形环境）
```

> Electron 的 `chrome-sandbox` 在本机不是 `root:4755`，启动器带了 `--no-sandbox`。
> 想开回沙箱，跑一次：
> `sudo chown root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox`

## 快速开始

```sh
npm install

# 跑测试（103 测试 + typecheck）
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
  appspec/    # AppSpec schema + 校验器 + slug（中文名→英文 preset id）
  compiler/   # 确定性编译器（persona / tools / compile / serialize / skill）
  definer/    # 产品经理与定义器（draft / interviewer / prompt / normalize / define / deepseek）
  prd/        # 11 节文档结构（sections）与确定性渲染（render）
  runtime/    # DSH library 运行时适配器（无头调用，用于验证）
  pipeline.ts # 编排层（runPipeline / runFinalize）
  cli.ts      # CLI
  server.ts   # Web 服务（SSE 对话 / finalize / 运行区代理）
public/       # 前端：index.html + static/app.css + static/app.js（含打印样式）
electron/     # 桌面外壳（main.cjs / launch.sh / icon.svg）
tests/        # 103 测试
scripts/      # 图标生成、DSH runtime spike
```

## 环境变量

- `DEEPSEEK_API_KEY`：DeepSeek API key（定义器 + 运行时 LLM 调用必需）
- `WANXIANG_PORT`：Web 服务端口（默认 8787，本机 8787 常被占用建议 8788）
- `WANXIANG_DSH_PORT`：万象启动或复用的 DSH Web 端口（默认 8891）
- `WANXIANG_DSH_HOME`：DSH 与万象共享的 home 目录（默认项目根目录下的 `.dsh-home`）

### 代理（配了代理的机器必看）

`npm start` 里带了两个变量，少一个都跑不起来：

- `NODE_USE_ENV_PROXY=1`：Node 内置 `fetch` 默认**不认** `HTTP(S)_PROXY`，不开这个，DeepSeek 调用直接 DNS 失败。
- `NO_PROXY=localhost,127.0.0.1,::1`：上面那个开关会把**回环请求也塞进代理**，导致万象探测不到本机的 DSH，报「DSH Web 启动超时」。

## 已知边界（M0/M1）

- 知君插件（`@centaur/plugin-memory-read/write`）尚未实现，助手当前以 DSH 兼容变体运行（无记忆绑定）；实现后恢复 `includeCentaurPlugins: true`
- **技能不隔离**：DSH 会整个忽略 preset 里给 `skill-filesystem` 写的 `config`（`customSkillDirs` 从不被扫描，`includeDefaultRoots: false` 也不生效），所以技能装在共享的 `$DSH_HOME/skills/`，助手之间彼此可见。技能名带 slug 前缀不会撞名，孤儿技能在每次安装时清理。DSH 支持按 preset 隔离技能后要回来改
- 「资料来源」这一问目前只能由用户自己写——知君的 `memory.list_scopes()` 还没有，给不出真实资料让他勾
- 应用 preset 目录名（＝DSH preset id）受 DSH `PRESET_ID` 正则约束（小写字母/数字/连字符），中文名经 `slugFromName` 哈希派生

## 相关文档

- 产品定位与架构：`~/Documents/万象-产品定位与架构PRD.md`
- 应用创建流程：`~/Documents/万象-应用创建流程设计.md`
- AppSpec schema：`~/Documents/万象-AppSpec-Schema.md`
