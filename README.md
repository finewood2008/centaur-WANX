# 万象（centaur-WANX）

超级个体的 Agent 创造器。以 DSH（DeepSeek Harness）为运行核心，把自然语言需求生成为可直接运行的 Agent。

## 这是什么

万象是半人马产品线的 Agent 创造器，面向超级个体（＝半人马个人＝OPC，一人公司）。你通过对话描述需求，万象引导你逐步完善，最终生成一个能直接运行的 Agent。

核心链路：**对话 → AppSpec（声明式定义）→ 编译器（确定性生成）→ DSH preset → 万象运行工作区**

## 四层架构

```
DSH（引擎）→ 知君插件＋底座（记忆）→ 万象（平台/元应用）→ 用户应用（DSH preset/bundle）
```

万象是统一对外产品，DSH 是运行核心。万象负责 Agent 定义、生成和工作区导航，运行工作区以同源全屏界面直接承载 DSH 原生的会话、工具调用、workspace 和权限能力；HTTP 与 WebSocket 均由万象统一代理，两者共享同一个 `DSH_HOME`，用户不需要切换产品或访问第二个服务地址。

## 功能特性

- **多轮对话引导创建**：引导者逐步提问，每轮给 3 个候选选项（选择题，参考 Claude plan 模式的交互），也可手动输入
- **AppSpec 声明式定义**：v1.0 冻结，只声明 goal / domain / capabilities / memory_binding / delivery / params
- **确定性编译器**：同一 AppSpec 永远产出同一应用包（persona 全文、DSH 插件列表）
- **统一运行工作区**：生成的 preset 安装到 DSH 的 preset 目录，运行态由万象品牌化的 DSH 原生界面全屏接管，不再嵌套第二套产品外壳
- **Web 产品 + CLI 双入口**：网页完成 Agent 创建和运行，或命令行一键生成

## 快速开始

```sh
npm install

# 跑测试（69 测试 + typecheck）
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
  compiler/   # 确定性编译器（persona / tools / compile / serialize）
  definer/    # 定义器（LLM → AppSpec：prompt / parse / normalize / define / interviewer / deepseek）
  runtime/    # DSH library 运行时适配器（实验/无头调用）
  pipeline.ts # 编排层
  cli.ts      # CLI
  server.ts   # Web 服务
public/       # 前端（对话创建 + 统一运行工作区）
tests/        # 69 测试
scripts/      # DSH runtime spike
```

## 环境变量

- `DEEPSEEK_API_KEY`：DeepSeek API key（定义器 + 运行时 LLM 调用必需）
- `WANXIANG_PORT`：Web 服务端口（默认 8787，本机 8787 常被占用建议 8788）
- `WANXIANG_DSH_PORT`：万象启动或复用的 DSH Web 端口（默认 8891）
- `WANXIANG_DSH_HOME`：DSH 与万象共享的 home 目录（默认项目根目录下的 `.dsh-home`）

## 已知边界（M0/M1）

- 知君插件（`@centaur/plugin-memory-read/write`）尚未实现，应用当前以 DSH 兼容变体运行（无记忆绑定）；实现后恢复 `includeCentaurPlugins: true`
- 应用 preset 目录名（＝DSH preset id）受 DSH `PRESET_ID` 正则约束（小写字母/数字/连字符），中文名经 `slugFromName` 哈希派生

## 相关文档

- 产品定位与架构：`~/Documents/万象-产品定位与架构PRD.md`
- 应用创建流程：`~/Documents/万象-应用创建流程设计.md`
- AppSpec schema：`~/Documents/万象-AppSpec-Schema.md`
