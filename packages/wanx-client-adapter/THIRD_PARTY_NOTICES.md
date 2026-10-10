# 第三方与来源说明

公司自有代码和文档遵循[专有许可](LICENSE)。公司声明不覆盖或撤销第三方既有授权。

- WANX 原生 API 类型与 schema 来自记录的平台快照；原始平台声明原样保存在[平台 NOTICE](third-party/native-platform-NOTICE)。
- 连接源码来自 Codeup `6ff9bfa02f4df9df650a25e7378891d74dbd0b8b` 的标准 Go SDK 0.2.0，以及该仓库交付中冻结的 Core 0.1.1。本项目没有替这些组件额外授予 MIT 许可。
- 标准 SDK 和 Core 原始源码内容未修改。本客户端的适配代码位于 `native/wanx/`、`native/cmd/` 和 `src/`，使用公开的 `OpenHTTPStream`、`OpenMessageStream` 接口，不包含旧的 omniaauth 内部凭据扩展。
- native host 的 22 项 Go 运行依赖、固定版本及原始许可文件索引见[Go 依赖清单](third-party/go-dependencies.json)。
- Node 运行依赖 `ws` 8.22.0 的原始版权和 MIT 许可见[ws LICENSE](third-party/ws-LICENSE)。
- 原生程序使用 Go 工具链构建；其随附声明见[Go LICENSE](third-party/Go-LICENSE)。

开发工具 TypeScript 与 Node 类型包由 npm 分别提供原始许可；它们不是本 npm 安装包的运行依赖。SDK 自有代码仍按公司专有产品交付。
