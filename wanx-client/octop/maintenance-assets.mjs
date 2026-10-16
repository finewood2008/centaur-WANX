import { readFile } from "node:fs/promises";

const prefix = "/__wanx_tools/";
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };

// Only packaged tool assets are served. API and WebSocket traffic continue
// through the authenticated box gateway; no privileged preload is installed.
export async function serveMaintenanceAsset(request, response, origin) {
  const pathname = new URL(request.url, origin).pathname;
  if (!pathname.startsWith(prefix)) return false;
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405, { allow: "GET, HEAD" }); response.end(); return true;
  }
  const relative = ["terminal", "desktop"].includes(pathname.slice(prefix.length))
    ? "maintenance.html"
    : /^assets\/[a-zA-Z0-9._-]+$/.test(pathname.slice(prefix.length)) ? pathname.slice(prefix.length) : null;
  const extension = relative?.slice(relative.lastIndexOf("."));
  if (!relative || !types[extension]) {
    response.writeHead(404); response.end("Tool asset not found"); return true;
  }
  try {
    const body = await readFile(new URL(`../local-ui/maintenance/${relative}`, import.meta.url));
    response.writeHead(200, {
      "content-type": types[extension],
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ${origin.replace(/^http/, "ws")}; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`,
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(404); response.end("Tool asset not found");
  }
  return true;
}
