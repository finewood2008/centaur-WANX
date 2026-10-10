"""Install a delivery tarball in a clean directory and execute it outside the SDK tree."""
from __future__ import annotations
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from source_state import HERE

SCRIPT = r'''
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createCentaurAIWanxClient, createCentaurAIWanxHost, createNativeHTTPTransport, operationRegistry, moduleRegistry } from "centaurai-wanx";
import { bindCentaurAIWanxElectron } from "centaurai-wanx/electron-main";
import { createCentaurAIWanxApp } from "centaurai-wanx/renderer";
const require = createRequire(import.meta.url);
assert.equal(typeof require("centaurai-wanx/electron-preload").exposeCentaurAIWanxPreload, "function");
assert.equal(typeof bindCentaurAIWanxElectron, "function");
assert.equal(typeof createCentaurAIWanxApp, "function");
assert.equal(operationRegistry.length, 457); assert.equal(Object.keys(moduleRegistry).length, 42);
let received;
const server = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  received = { url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() };
  response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ native: true }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const policy = { applicationId: "omnia-desktop", operations: operationRegistry.map(o => o.operationId), agents: ["consumer-agent"], sockets: [] };
const transport = await createNativeHTTPTransport({ baseURL: `http://127.0.0.1:${server.address().port}`, token: "synthetic-host-only", policy });
const sdk = createCentaurAIWanxClient({ transport, policy });
try {
  const result = await sdk.agents.use("consumer-agent").memory.listAtoms({ body: { limit: 20 } });
  assert.deepEqual(result.body, { native: true });
  assert.equal(received.url, "/api/agents/consumer-agent/memory/atoms/list");
  assert.equal(received.headers.authorization, "Bearer synthetic-host-only");
  assert.deepEqual(JSON.parse(received.body), { limit: 20 });
} finally { await sdk.close(); await new Promise(resolve => server.close(resolve)); }
let stored = null;
const host = await createCentaurAIWanxHost({ consumerBaseURL: "https://control.example.invalid/prod-api", trustedGatewayHosts: ["gateway.example.invalid"], trustedICEHosts: ["ice.example.invalid"], secureStore: { load: async () => stored, save: async value => { stored = value; }, clear: async () => { stored = null; } }, policy });
assert.equal(await host.auth.current(), null); await host.dispose();
console.log("Fresh installed package: ESM/CJS/types/native host/memory HTTP passed");
'''

TYPES = '''
import { createCentaurAIWanxClient, type WanxTransport, type ApplicationPolicy } from "centaurai-wanx";
import { createCentaurAIWanxApp, type RendererBridge } from "centaurai-wanx/renderer";
declare const transport: WanxTransport;
declare const policy: ApplicationPolicy;
declare const bridge: RendererBridge;
const sdk = createCentaurAIWanxClient({ transport, policy });
sdk.agents.use("consumer-agent").memory.listAtoms({ body: { limit: 20 } });
// @ts-expect-error Public requests cannot provide credentials.
sdk.agents.use("consumer-agent").memory.listAtoms({ header: { Authorization: "page-token" } });
const app = createCentaurAIWanxApp({ bridge, policy });
app.devices.list().then(devices => devices.filter(device => device.online && device.status.length > 0));
app.connection.connect({ deviceId: "selected" }).then(client => {
  // @ts-expect-error Renderer has no trusted native invoker.
  client.native;
});
'''

def main() -> None:
    tarball = Path(sys.argv[1]).resolve()
    npm, node = shutil.which("npm"), shutil.which("node")
    if not npm or not node:
        raise SystemExit("Node.js 22 and npm required")
    receipt = HERE / "artifacts/consumer-check.json"
    receipt.unlink(missing_ok=True)
    with tempfile.TemporaryDirectory(prefix="centaurai-wanx-consumer-") as temp:
        consumer = Path(temp)
        (consumer / "package.json").write_text(json.dumps({"name": "wanx-clean-consumer-check", "private": True, "type": "module"}))
        subprocess.run([npm, "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", str(tarball), "typescript@5.8.3", "@types/node@22.20.4"], cwd=consumer, check=True)
        (consumer / "check.ts").write_text(TYPES)
        (consumer / "tsconfig.json").write_text(json.dumps({"compilerOptions": {"strict": True, "target": "ES2022", "module": "NodeNext", "noEmit": True}, "include": ["check.ts"]}))
        subprocess.run([node, "node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], cwd=consumer, check=True)
        (consumer / "check.mjs").write_text(SCRIPT)
        subprocess.run([node, "check.mjs"], cwd=consumer, check=True)
    report = {"package": tarball.name, "sha256": hashlib.sha256(tarball.read_bytes()).hexdigest(), "fresh_install": "passed", "installed_exports_esm_cjs_types": "passed", "installed_native_host_and_memory_http": "passed", "platform": "darwin-arm64", "hardware_integration": "not_performed"}
    receipt.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False))

if __name__ == "__main__":
    main()
