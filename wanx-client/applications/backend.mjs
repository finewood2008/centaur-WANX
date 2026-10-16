import { evaluateApplicationCompatibility, validateCompatibility } from "./compatibility.mjs";

const fail = code => Object.assign(new Error(code), { code });
const safeCode = value => typeof value === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(value);

/** No credentials or readiness evidence survive the authenticated box connection. */
export function createApplicationBackend({ client, account, clientVersion }) {
  function assertIdentity(captured, connection) {
    const current = connection.context();
    if (JSON.stringify([current.accountId, current.clientId, current.boxId]) !== captured ||
        account.getIdentity()?.accountId !== current.accountId || current.connection !== "ready") throw fail("UPDATE_SESSION_CHANGED");
    return current;
  }
  async function fixedConnection(applicationId, compatibility) {
    if (client.snapshot().phase !== "ready") throw fail("NETWORK_NOT_READY");
    const connection = await client.applicationConnection(applicationId, { backendProductId: compatibility.backendProductId });
    const current = connection.context();
    const captured = JSON.stringify([current.accountId, current.clientId, current.boxId]);
    const check = () => assertIdentity(captured, connection);
    check();
    async function post(path, body) {
      check();
      const response = await connection.request({ path, method: "POST", headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) });
      check();
      let value;
      try { value = JSON.parse(response.body.toString("utf8")); } catch { throw fail("APPLICATION_PREPARATION_INVALID"); }
      if (response.status < 200 || response.status >= 300)
        throw fail(safeCode(value?.code) ? value.code : [401, 403].includes(response.status) ? "APP_ENTITLEMENT_REQUIRED" : "APPLICATION_RESOURCES_NOT_READY");
      return value;
    }
    return { connection, current, check, post };
  }
  async function prepare(input, fixed) {
    const { manifest, descriptor } = input;
    if (manifest.protocolVersion !== 3) return null;
    validateCompatibility(manifest.compatibility, 3);
    if (!descriptor?.artifactId || descriptor.schemaVersion !== 3) throw fail("APPLICATION_RESOURCE_ARTIFACT_REQUIRED");
    const result = await fixed.post("/api/platform/applications/prepare", { schemaVersion: 1,
      applicationId: manifest.applicationId, artifactId: descriptor.artifactId });
    const observedAt = Date.parse(result?.observedAt), now = Date.now();
    if (result?.schemaVersion !== 1 || !["ready", "blocked"].includes(result.status) ||
        result.applicationId !== manifest.applicationId || result.artifactId !== descriptor.artifactId ||
        result.deviceId !== fixed.current.boxId || result.backendProductId !== manifest.compatibility.backendProductId || !Number.isFinite(observedAt) || observedAt < now - 300000 || observedAt > now + 60000 ||
        !Array.isArray(result.resources) || result.resources.length > 256 || !Array.isArray(result.bindings) || result.bindings.length > 256)
      throw fail("APPLICATION_PREPARATION_INVALID");
    if (result.status === "blocked" || result.authorization?.status !== "ready")
      return { ...result, status: "blocked", code: result.authorization?.status !== "ready"
        ? safeCode(result.authorization?.code) ? result.authorization.code : "APP_AUTHORIZATION_UNVERIFIED"
        : safeCode(result.code) ? result.code : "APPLICATION_RESOURCES_NOT_READY" };
    // A successful download alone is not readiness: every dependency needs its
    // verified installed version and the actual Octop instance/package binding.
    const evidence = evaluateApplicationCompatibility({ ...manifest, compatibility: { ...manifest.compatibility, backendContracts: [] } }, {
      clientVersion, hostProtocol: 1, expectedDeviceId: fixed.current.boxId,
      backend: { ...result, productId: manifest.compatibility.backendProductId },
    });
    if (evidence.status !== "ready") throw fail(evidence.checks[0]?.code || "APPLICATION_PREPARATION_INVALID");
    return result;
  }
  async function prepareApplication(input) {
    if (input.manifest.protocolVersion !== 3) return null;
    if (client.snapshot().phase !== "ready") return { status: "pending", code: "APPLICATION_RESOURCES_PENDING" };
    const fixed = await fixedConnection(input.manifest.applicationId, input.manifest.compatibility);
    const result = await prepare(input, fixed);
    fixed.check();
    return { status: result.status, ...(result.code ? { code: result.code } : {}) };
  }
  async function getCompatibilityContext({ manifest, descriptor, phase }) {
    const state = client.snapshot(), compatibility = manifest?.compatibility || descriptor?.manifest?.compatibility;
    const backendRequired = ["launch", "rollback"].includes(phase) || phase === "candidate" && (manifest.protocolVersion !== 3 || state.phase === "ready") && Boolean(state.connection?.deviceId);
    const result = { clientVersion, hostProtocol: 1, backendRequired, expectedDeviceId: state.connection?.deviceId || null };
    if (!backendRequired || !compatibility) return result;
    if (manifest.protocolVersion !== 3) {
      const captured = JSON.stringify({ account: account.getIdentity(), deviceId: state.connection?.deviceId });
      const response = await client.applicationRequest({ path: "/api/platform/applications/readiness", method: "POST",
        headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ schemaVersion: 1, applicationId: manifest.applicationId, compatibility })) });
      if (captured !== JSON.stringify({ account: account.getIdentity(), deviceId: client.snapshot().connection?.deviceId })) throw fail("UPDATE_SESSION_CHANGED");
      if (response.status < 200 || response.status >= 300) throw fail("CONTRACT_UNSUPPORTED");
      result.backend = JSON.parse(response.body.toString("utf8"));
      return result;
    }
    const fixed = await fixedConnection(manifest.applicationId, compatibility);
    const prepared = phase === "launch" ? await prepare({ manifest, descriptor }, fixed) : null;
    if (prepared?.status === "blocked") throw fail(prepared.code);
    result.backend = await fixed.post("/api/platform/applications/readiness", {
      schemaVersion: 1, applicationId: manifest.applicationId, artifactId: descriptor?.artifactId, compatibility,
    });
    fixed.check();
    // Readiness is a new observation: never overwrite a detected drift or
    // denial using an earlier successful prepare response.
    if (phase === "launch") {
      const bindings = (Array.isArray(result.backend.bindings) ? result.backend.bindings : []).filter(item => compatibility.resourceDependencies.some(dep => dep.kind === item?.kind && dep.resourceId === item.resourceId));
      result.applicationConnection = {
        ...fixed.connection,
        context: () => ({ ...fixed.check(), resourceBindings: structuredClone(bindings), applicationId: manifest.applicationId, artifactId: descriptor.artifactId }),
      };
    }
    return result;
  }
  return { getCompatibilityContext, prepareApplication };
}
