/**
 * 万象的 cordis 插件入口。
 *
 * bundle 的 cordis.patch.yml 把这一行 insert 进 web 组合；激活条件是
 * `inject` 里的服务全部就绪。拿到 ctx 之后做两件事：
 *   1. 把万象的路由挂上 DSH 的 webserver（exact /、/health，prefix /static、/wanx）
 *   2. 把 ctx 交给 server 层——「跑一次」用它建会话，与浏览器细聊同一个 agent 平面
 *
 * 业务逻辑全部住在仓库的 src/ 下；这个包只是 DSH 组合层的接线员。
 * 整个进程跑在 tsx 下，所以 .ts 入口可以被 loader 直接 import。
 */
import { registerWanxiangRoutes } from "../../../src/server.ts";

export const name = "wanxiang";

// webServer：挂路由。agents/sessions/agentPresets/agentDefaultModel：跑一次要用。
// 列进 inject 保证激活时全部就绪，省掉每个请求里的存在性检查。
export const inject = ["webServer", "agents", "sessions", "agentPresets", "agentDefaultModel"];

export function apply(ctx: any): void {
  registerWanxiangRoutes(ctx);
}
