# 万象（centaur-WANX）

超级个体的应用创造器。以 DSH（DeepSeek Harness）为引擎底座，把「你的记忆 + 一组 Agent」组装成为你而造的应用。

## 这是什么

万象是半人马产品线的 agent 创造器，面向超级个体（＝半人马个人＝OPC，一人公司）。你通过对话描述需求，万象引导你逐步完善，最终生成一个能在 DSH 框架下真正运行的应用。

核心链路：**对话 → AppSpec（声明式定义）→ 编译器（确定性生成）→ DSH preset → 运行**

## 四层架构

```
DSH（引擎）→ 知君插件＋底座（记忆）→ 万象（平台/元应用）→ 用户应用（DSH preset/bundle）
```

## 功能特性

- **多轮对话引导创建**：引导者逐步提问，每轮给 3 个候选选项（选择题，参考 Claude plan 模式的交互），也可手动输入
- **AppSpec 声明式定义**：v1.0 冻结，只声明 goal / domain / capabilities / memory_binding / delivery / params
- **确定性编译器**：同一 AppSpec 永远产出同一应用包（persona 全文、DSH 插件列表）
- **框架下运行**：生成的应用经 DSH library API 真实跑起来（boot headless → agent-presets 挂载 → 应用 persona 生效）
- **Web 界面 + CLI 双入口**：网页对话创建/运行，或命令行一键生成

## 快速开始

```sh
npm install

# 跑测试（68 测试 + typecheck）
npm test
npm run typecheck

# 启动 Web 服务（对话创建 + 应用运行界面）
export DEEPSEEK_API_KEY=你的key
WANXIANG_PORT=8788 npm start
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
  runtime/    # DSH 运行时适配器（应用在框架下运行）
  pipeline.ts # 编排层
  cli.ts      # CLI
  server.ts   # Web 服务
public/       # 前端（对话创建 + 应用运行界面）
tests/        # 68 测试
scripts/      # DSH runtime spike
```

## 环境变量

- `DEEPSEEK_API_KEY`：DeepSeek API key（定义器 + 运行时 LLM 调用必需）
- `WANXIANG_PORT`：Web 服务端口（默认 8787，本机 8787 常被占用建议 8788）

## 已知边界（M0/M1）

- 知君插件（`@centaur/plugin-memory-read/write`）尚未实现，应用当前以 DSH 兼容变体运行（无记忆绑定）；实现后恢复 `includeCentaurPlugins: true`
- 应用 preset 目录名（＝DSH preset id）受 DSH `PRESET_ID` 正则约束（小写字母/数字/连字符），中文名经 `slugFromName` 哈希派生

## 相关文档

- 产品定位与架构：`~/Documents/万象-产品定位与架构PRD.md`
- 应用创建流程：`~/Documents/万象-应用创建流程设计.md`
- AppSpec schema：`~/Documents/万象-AppSpec-Schema.md`
