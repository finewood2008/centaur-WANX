# WANX Host 应用接入（P0–P3）

`wanx-client` 是应用 Host。应用包声明 `application.manifest.json`，由 Host 校验并安装到按 `applicationId/version` 隔离的目录。启动时 Host 生成一次性 launch 环境变量，应用主进程通过 Unix domain socket（Windows 为 named pipe）发送带 token 的 NDJSON 请求。

当前固定方法只有三类：

- `context.get`：当前账号、盒子和连接状态；
- `identity.get`：需要 `identity.read` 能力的盒端身份读取；
- `http.request`：需要 `http.request` 能力、且路径必须是 `/api/` 下的盒端公开请求。

长期平台 token、盒端 JWT、目标盒端地址和网络密钥不进入应用环境、渲染器或应用磁盘。Host 的连接 generation 失效时，应用通道随盒端会话关闭。

知君的发行根目录是 `desktop/`。`tools/prepare-desktop.mjs` 会把根目录 manifest 复制到该目录；Host 安装知君时传入 `desktop/`，不能把仓库根目录当作发行包。知君仍保留独立 Web/LAN 模式：只有检测到 `WANX_HOST_*` 环境变量时，`desktop/shell/runtime.cjs` 才使用 Host transport。

P0–P3 的 seam 验收覆盖 manifest 路径校验、原子安装、IPC token/能力/路径校验、启动环境变量和知君 Host client。聊天 WebSocket、上传流和应用自动更新属于后续协议扩展。
