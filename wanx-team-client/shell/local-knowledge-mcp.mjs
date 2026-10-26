import http from 'node:http';

const fail = (code, status = 403) => Object.assign(Error(code), { code, status });
const endpoint = '/mcp/starlink';

// Existing wmcp_ capabilities belong to this desktop session, not the box's
// server MCP. Expose only their finite knowledge surface on loopback.
export function createLocalKnowledgeMcp({ client, knowledgeCapabilities, scope, assertScope }) {
  const state = { port: 0, links: [] };
  let closed = false, starting, server, bridge;
  const assertLocal = bound => {
    if (closed || !bound || client.snapshot().connection?.authorization !== 'local-trust-v1') throw fail('MCP_SESSION_CLOSED');
    assertScope(bound);
  };
  const start = () => {
    if (starting) return starting;
    const pending = (async () => {
      const { createWanxMcpBridge } = await import('./wanx-mcp-bridge.mjs');
      assertLocal(scope());
      const denied = () => { throw fail('MCP_SURFACE_INVALID'); };
      bridge = createWanxMcpBridge({ client, state, scope, assertScope: assertLocal,
        knowledgeCapabilities, access: denied, remote: denied });
      server = http.createServer({ requestTimeout: 30000, headersTimeout: 10000, maxHeaderSize: 8192 }, (req, res) => {
        void (async () => {
          try {
            assertLocal(scope());
            if (req.headers.host !== `127.0.0.1:${state.port}` || req.headers.origin) throw fail('MCP_ORIGIN_DENIED');
            if (req.url !== endpoint) throw fail('MCP_PATH_DENIED', 400);
            await bridge.handle(req, res);
          } catch (error) {
            if (res.destroyed) return;
            if (res.headersSent) { res.destroy(); return; }
            res.writeHead(error.status || 403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: error.code || 'MCP_UNAVAILABLE' } }));
          }
        })();
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); state.port = server.address().port; resolve(); });
      });
    })();
    starting = pending;
    void pending.catch(() => { if (starting === pending) starting = undefined; });
    return pending;
  };
  return {
    async details() {
      const bound = scope(); assertLocal(bound);
      await start(); assertLocal(bound);
      return bridge.details('starlink');
    },
    async close() {
      if (closed) return;
      closed = true; knowledgeCapabilities.clear();
      await starting?.catch(() => {});
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    },
  };
}
