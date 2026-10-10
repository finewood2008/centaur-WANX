// Type-check-only example of the implemented SDK; not executed by tests.
import { createCentaurAIWanxHost, type MemoryApi, type SecureStore, type ApplicationPolicy } from "centaurai-wanx";
declare const secureStore: SecureStore;
declare const policy: ApplicationPolicy;
async function example() {
  const host = await createCentaurAIWanxHost({
    consumerBaseURL: "https://boss.nexusaos.qitus.cn/prod-api",
    trustedGatewayHosts: ["approved-gateway.example"], trustedICEHosts: ["approved-ice.example"],
    secureStore, policy,
  });
  const identity = await host.auth.current();
  if (!identity) return; // Product invokes SDK login UI before entering this flow.
  const device = (await host.devices.list())[0];
  if (!device) return;
  const session = await host.connection.connect({ deviceId: device.deviceId });
  const memory = session.agents.use("authorized-agent").memory;
  await memory.listAtoms({ body: { limit: 20, include_deprecated: false } });
  await memory.getAtom({ path: { atom_id: "native-atom-id" } });
  await memory.statsGrowth({ query: { days: 30 } });
  // A frozen native operation is available to this trusted host if authorized.
  await session.native.invoke("list_atoms_api_agents__agent_id__memory_atoms_list_post", {
    path: { agent_id: "authorized-agent" }, body: { limit: 20 },
  });
  await session.close();
  await host.dispose();
}
void example;

declare const memory: MemoryApi;
// Meaningful negative contract checks: page cannot supply credentials or identity.
// @ts-expect-error Native authorization headers are absent from the public facade.
memory.listAtoms({ header: { authorization: "Bearer supplied-by-page" } });
// @ts-expect-error Native query tokens and as_user are absent from this request.
memory.listAtoms({ query: { access_token: "supplied-by-page", as_user: 99 } });
// @ts-expect-error Agent identity is already bound by the client.
memory.getAtom({ path: { agent_id: "another-agent", atom_id: "native-atom-id" } });
// @ts-expect-error Native atom identifiers remain required.
memory.getAtom({});

// Management contract rejects ambiguous access and release targets at compile time.
import type { ApplicationsApi } from "centaurai-wanx";
declare const applications: ApplicationsApi;
applications.putAccess("demo.product", { user_id: 12, enabled: true });
applications.compatibleRelease("demo.product", { platform: "windows", arch: "x64", current_version: "0.1.0" });
// @ts-expect-error Management calls cannot inject native credentials.
applications.list({ token: "renderer-token" });
// @ts-expect-error Grants use numeric user identity and explicit enabled state.
applications.putAccess("demo.product", { username: "other", enabled: true });
// @ts-expect-error A release requires a supported installation target.
applications.compatibleRelease("demo.product", { platform: "linux", arch: "x64", current_version: "0.1.0" });
