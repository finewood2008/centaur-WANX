/**
 * 万象的 cordis 插件入口。
 *
 * bundle 的 cordis.patch.yml 把这一行 insert 进组合；激活条件是 `inject`
 * 里的服务全部就绪。拿到 ctx 之后只做一件事：把万象的路由（界面 + API +
 * 对话链路）挂上 webserver，并把 ctx 交给 server 层——「跑一次」和「对话」
 * 都在这个 ctx 上建会话。
 *
 * 业务逻辑全部住在仓库的 src/ 下；这个包只是组合层的接线员。
 * 整个进程跑在 tsx 下，所以 .ts 入口可以被 loader 直接 import。
 */
import { registerWanxiangRoutes } from "../../../src/server.ts";

export const name = "wanxiang";

// webServer：挂路由。agents/sessions/agentPresets/agentDefaultModel：建会话。
// sessionQuery：历史对话列表与回放。sessionPersistence：agents.resume 的前置。
// tools：presentCall/presentResult（工具卡片的白话标题）。
// 列进 inject 保证激活时全部就绪——缺一个整个插件不激活，所以每一项都必须
// 确实由组合提供（sessionQuery/sessionPersistence/tools 都在 dsh-base 里）。
export const inject = [
  "webServer",
  "agents",
  "sessions",
  "agentPresets",
  "agentDefaultModel",
  "sessionQuery",
  "sessionPersistence",
  "tools",
];

export function apply(ctx: any): void {
  registerWanxiangRoutes(ctx);
}
