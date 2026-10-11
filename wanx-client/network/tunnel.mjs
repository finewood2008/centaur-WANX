import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { isIP } from "node:net";

const failure = (code) => Object.assign(new Error(code), { code });

/** Connect only via the app-owned sidecar; there is no operating-system fallback. */
export function createTunnelAgent({ url, proxy, timeoutMs = 15_000 }) {
  const target = new URL(url);
  const secure = target.protocol === "https:";
  const host = target.hostname.replace(/^\[|\]$/g, "");
  const port = Number(target.port || (secure ? 443 : 80));
  const authority = `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
  const agent = secure
    ? new https.Agent({ keepAlive: true })
    : new http.Agent({ keepAlive: true });
  const connections = new Set();
  let destroyed = false;
  const track = (socket) => {
    connections.add(socket);
    // The raw CONNECT socket can outlive TLS/request listeners during teardown.
    // Keep its cancellation error handled while request/TLS listeners also run.
    socket.on("error", () => {});
    socket.once("close", () => connections.delete(socket));
    return socket;
  };
  agent.createConnection = (options, callback) => {
    if (destroyed) {
      callback(failure("network_disabled"));
      return;
    }
    if (
      String(options.host).replace(/^\[|\]$/g, "") !== host ||
      Number(options.port) !== port
    ) {
      callback(failure("tunnel_target_mismatch"));
      return;
    }
    let settled = false;
    const done = (error, socket) => {
      if (settled) return;
      settled = true;
      callback(error, socket);
    };
    const request = http.request({
      host: "127.0.0.1",
      port: proxy.port,
      method: "CONNECT",
      path: authority,
      agent: false,
      headers: { Host: authority, Authorization: `Bearer ${proxy.token}` },
    });
    connections.add(request);
    request.once("close", () => connections.delete(request));
    request.setTimeout(timeoutMs, () =>
      request.destroy(failure("tunnel_timeout")),
    );
    request.once("error", (error) => done(error));
    request.once("connect", (response, socket, head) => {
      request.setTimeout(0);
      track(socket);
      if (destroyed || response.statusCode !== 200) {
        socket.destroy();
        done(failure(destroyed ? "network_disabled" : "tunnel_rejected"));
        return;
      }
      if (head.length) socket.unshift(head);
      if (!secure) {
        done(null, socket);
        return;
      }
      // Preserve upstream TLS verification. The CONNECT credential is never
      // included in the upstream request or TLS connection.
      const encrypted = track(
        tls.connect({
          ...options,
          socket,
          servername: isIP(host) ? undefined : host,
          rejectUnauthorized: true,
        }),
      );
      encrypted.setTimeout(timeoutMs, () =>
        encrypted.destroy(failure("tunnel_timeout")),
      );
      encrypted.once("error", (error) => done(error));
      encrypted.once("secureConnect", () => {
        encrypted.setTimeout(0);
        done(null, encrypted);
      });
    });
    request.end();
  };
  const destroy = agent.destroy.bind(agent);
  // Close only transport sockets on a confirmed network change; the gateway
  // retains this Agent and can open fresh tunnels once the engine recovers.
  agent.resetConnections = (code = "network_recovering") => {
    for (const connection of connections)
      connection.destroy(failure(code));
    connections.clear();
    destroy();
  };
  agent.destroy = () => {
    destroyed = true;
    agent.resetConnections("network_disabled");
  };
  agent.probe = ({ timeoutMs: deadlineMs = 1_000 } = {}) =>
    new Promise((resolve) => {
      let done = false;
      const check = createTunnelAgent({ url, proxy, timeoutMs: deadlineMs });
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        check.destroy();
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), deadlineMs);
      // TCP/TLS only: no application request or user action is replayed.
      check.createConnection({ host, port }, (error, socket) => {
        socket?.destroy();
        finish(!error);
      });
    });
  return agent;
}
