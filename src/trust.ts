import type { IncomingMessage } from "node:http";

/**
 * 浏览器信任栅栏 —— 万象版。
 *
 * 万象的 /wanx API 直接挂在 DSH 的 webserver 上，绕过了 DSH connection 插件
 * 给它自己 /api 挂的那道栅栏。缺了它，/wanx/api/mcp 这种「写一行组合、HMR
 * 热加载就 spawn 一个 stdio 命令」的端点，能被恶意网页经 CSRF / DNS rebinding
 * 驱动成任意命令执行——攻击者不需要读响应，同源策略拦不住状态改变请求。
 *
 * 万象只绑 127.0.0.1、不支持 LAN，所以比 DSH 的通用版更简单：Host 必须是
 * 回环，任何带 origin 的请求必须同源，跨站的 sec-fetch-site 一律拒。挡住的是
 * ① DNS rebinding（攻击者域名的 Host 不是回环）② 跨站 POST（origin/sfs 不符）。
 * 放行的是 ③ 用户浏览器里对本机的正常同源访问。
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function hostnameOf(authority: string): string | null {
  try {
    return new URL(`http://${authority}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostOf(authority: string): string | null {
  try {
    return new URL(`http://${authority}`).host.toLowerCase();
  } catch {
    return null;
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** 这个请求可不可以到达 /wanx 的 API。 */
export function isTrustedWanxRequest(req: IncomingMessage): boolean {
  const host = header(req, "host");
  if (host === undefined) return false;
  const hostname = hostnameOf(host);
  if (hostname === null || !LOOPBACK.has(hostname)) return false;

  // 跨站发起的请求直接拒（浏览器如实标注时）。
  if (header(req, "sec-fetch-site") === "cross-site") return false;

  // 带 origin 的必须同源——挡住跨站 fetch，即使它伪造了 Host 也过不了这关。
  const origin = header(req, "origin");
  if (origin !== undefined) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return false;
    }
    if (originHost !== hostOf(host)) return false;
  }
  return true;
}
