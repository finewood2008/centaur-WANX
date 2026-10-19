import { evaluateApplicationCompatibility, validateCompatibility } from "./compatibility.mjs";

const fail = code => Object.assign(new Error(code), { code });
const safeCode = value => typeof value === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(value);

function preparationResponse(response) {
  let value;
  try { value = JSON.parse(response.body.toString("utf8")); }
  catch { if (response.status >= 200 && response.status < 300) throw fail("APPLICATION_PREPARATION_INVALID"); }
  if (response.status < 200 || response.status >= 300) {
    // An HTTP authentication failure is not evidence of a missing app grant.
    const code = ["AUTH_FAILED", "FORBIDDEN"].includes(value?.code) ? "APP_AUTHORIZATION_UNVERIFIED"
      : safeCode(value?.code) ? value.code : [401, 403].includes(response.status) ? "APP_AUTHORIZATION_UNVERIFIED"
      : response.status === 404 ? "BACKEND_CONTRACT_INCOMPATIBLE" : "APPLICATION_PREPARATION_UNAVAILABLE";
    throw fail(code);
  }
  return value;
}

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
      return preparationResponse(response);
    }
    return { connection, current, check, post };
  }
  function validateBinding(result, input, fixed) {
    const scope = result?.bindingScope, expected = input.manifest.bindingScope || input.bindingScope;
    if (!/^[a-f0-9]{64}$/.test(result?.bindingSetId || "") ||
        typeof result.operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(result.operationId) ||
        input.operationId && input.operationId !== result.operationId ||
        (input.bindingSetId || input.manifest.bindingSetId) && (input.bindingSetId || input.manifest.bindingSetId) !== result.bindingSetId ||
        !scope || scope.accountId !== fixed.current.accountId || scope.deviceId !== fixed.current.boxId ||
        scope.artifactId !== input.descriptor.artifactId || !Number.isSafeInteger(scope.ownershipEpoch) || scope.ownershipEpoch < 1 ||
        expected && ["accountId", "deviceId", "ownershipEpoch", "artifactId"].some(key => expected[key] !== scope[key]))
      throw fail("APPLICATION_PREPARATION_INVALID");
    return { bindingSetId: result.bindingSetId, operationId: result.operationId, bindingScope: structuredClone(scope) };
  }
  async function prepare(input, fixed, candidate = false) {
    const { manifest, descriptor } = input;
    if (manifest.protocolVersion !== 3) return null;
    validateCompatibility(manifest.compatibility, 3);
    if (!descriptor?.artifactId || descriptor.schemaVersion !== 3) throw fail("APPLICATION_RESOURCE_ARTIFACT_REQUIRED");
    if (candidate && (typeof input.operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.operationId)))
      throw fail("APPLICATION_PREPARATION_INVALID");
    const result = await fixed.post(candidate ? "/api/platform/applications/candidates/prepare" : "/api/platform/applications/prepare", {
      schemaVersion: candidate ? 2 : 1, applicationId: manifest.applicationId, artifactId: descriptor.artifactId,
      ...(candidate ? { operationId: input.operationId } : {}),
    });
    const observedAt = Date.parse(result?.observedAt), now = Date.now();
    if (result?.schemaVersion !== (candidate ? 2 : 1) || !["ready", "blocked"].includes(result.status) ||
        result.applicationId !== manifest.applicationId || result.artifactId !== descriptor.artifactId ||
        result.deviceId !== fixed.current.boxId || result.backendProductId !== manifest.compatibility.backendProductId || !Number.isFinite(observedAt) || observedAt < now - 300000 || observedAt > now + 60000 ||
        !Array.isArray(result.resources) || result.resources.length > 256 || !Array.isArray(result.bindings) || result.bindings.length > 256)
      throw fail("APPLICATION_PREPARATION_INVALID");
    if (result.status === "blocked" || result.authorization?.status !== "ready")
      return { ...result, status: "blocked", code: result.authorization?.status !== "ready"
        ? safeCode(result.authorization?.code) ? result.authorization.code : "APP_AUTHORIZATION_UNVERIFIED"
        : safeCode(result.code) ? result.code : "APPLICATION_RESOURCES_NOT_READY" };
    if (candidate) validateBinding(result, input, fixed);
    // A successful download alone is not readiness: every dependency needs its
    // verified installed version and the actual Octop instance/package binding.
    const evidence = evaluateApplicationCompatibility({ ...manifest, compatibility: { ...manifest.compatibility, backendContracts: [] } }, {
      clientVersion, hostProtocol: 1, expectedDeviceId: fixed.current.boxId,
      backend: { ...result, schemaVersion: 1, productId: manifest.compatibility.backendProductId },
    });
    if (evidence.status !== "ready") throw fail(evidence.checks[0]?.code || "APPLICATION_PREPARATION_INVALID");
    return result;
  }
  async function candidateReadiness(input, fixed, binding) {
    const { manifest, descriptor } = input;
    const backend = await fixed.post("/api/platform/applications/readiness", {
      schemaVersion: 2, applicationId: manifest.applicationId, artifactId: descriptor.artifactId,
      compatibility: manifest.compatibility, bindingSetId: binding.bindingSetId,
    });
    if (backend?.schemaVersion !== 2 || backend.applicationId !== manifest.applicationId || backend.artifactId !== descriptor.artifactId)
      throw fail("APPLICATION_PREPARATION_INVALID");
    validateBinding(backend, { ...input, ...binding }, fixed);
    const context = { ...backend, schemaVersion: 1 };
    const evidence = evaluateApplicationCompatibility(manifest, {
      clientVersion, hostProtocol: 1, expectedDeviceId: fixed.current.boxId, backend: context,
    });
    if (evidence.status !== "ready") throw fail(evidence.checks[0]?.code || "APPLICATION_PREPARATION_INVALID");
    if (backend.status !== "ready" || Array.isArray(backend.checks) && backend.checks.length)
      throw fail(safeCode(backend.checks?.[0]?.code) ? backend.checks[0].code : "APPLICATION_RESOURCES_NOT_READY");
    return context;
  }
  async function prepareApplication(input) {
    if (input.manifest.protocolVersion !== 3) return null;
    validateCompatibility(input.manifest.compatibility, 3);
    if (!input.manifest.compatibility.resourceDependencies.length) return { status: "ready" };
    if (client.snapshot().phase !== "ready") return { status: "pending", code: "APPLICATION_RESOURCES_PENDING" };
    const fixed = await fixedConnection(input.manifest.applicationId, input.manifest.compatibility);
    const result = await prepare(input, fixed, true);
    if (result.status === "ready") await candidateReadiness(input, fixed, validateBinding(result, input, fixed));
    fixed.check();
    if (result.status !== "ready") return { status: "blocked", ...(result.code ? { code: result.code } : {}) };
    // Keep the authenticated connection guard until the installer atomically
    // publishes its pointer. Preparing successfully is not a durable grant.
    return { status: "ready", ...validateBinding(result, input, fixed), assertCurrent: fixed.check };
  }
  async function getCompatibilityContext({ manifest, descriptor, phase, bindingSetId = manifest?.bindingSetId, bindingScope = manifest?.bindingScope }) {
    const state = client.snapshot(), compatibility = manifest?.compatibility || descriptor?.manifest?.compatibility;
    const backendRequired = ["launch", "rollback"].includes(phase) || phase === "candidate" && (manifest.protocolVersion !== 3 || state.phase === "ready") && Boolean(state.connection?.deviceId);
    const result = { clientVersion, hostProtocol: 1, backendRequired, expectedDeviceId: state.connection?.deviceId || null };
    if (!backendRequired || !compatibility) return result;
    if (manifest.protocolVersion !== 3) {
      const captured = JSON.stringify({ account: account.getIdentity(), deviceId: state.connection?.deviceId });
      const response = await client.applicationRequest({ path: "/api/platform/applications/readiness", method: "POST",
        headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ schemaVersion: 1, applicationId: manifest.applicationId, compatibility })) });
      if (captured !== JSON.stringify({ account: account.getIdentity(), deviceId: client.snapshot().connection?.deviceId })) throw fail("UPDATE_SESSION_CHANGED");
      result.backend = preparationResponse(response);
      return result;
    }
    const fixed = await fixedConnection(manifest.applicationId, compatibility);
    const candidate = Boolean(bindingSetId);
    const prepared = phase === "launch" && !candidate ? await prepare({ manifest, descriptor }, fixed) : null;
    if (prepared?.status === "blocked") throw fail(prepared.code);
    result.backend = candidate
      ? await candidateReadiness({ manifest, descriptor }, fixed, { bindingSetId, bindingScope, operationId: manifest.operationId })
      : await fixed.post("/api/platform/applications/readiness", {
        schemaVersion: 1, applicationId: manifest.applicationId, artifactId: descriptor?.artifactId, compatibility,
      });
    fixed.check();
    result.assertCurrent = fixed.check;
    // Readiness is a new observation: never overwrite a detected drift or
    // denial using an earlier successful prepare response.
    if (phase === "launch") {
      const bindings = (Array.isArray(result.backend.bindings) ? result.backend.bindings : []).filter(item => compatibility.resourceDependencies.some(dep => dep.kind === item?.kind && dep.resourceId === item.resourceId));
      result.applicationConnection = {
        ...fixed.connection,
        context: () => ({ ...fixed.check(), resourceBindings: structuredClone(bindings), applicationId: manifest.applicationId, artifactId: descriptor.artifactId,
          ...(candidate ? { bindingSetId, bindingScope: structuredClone(result.backend.bindingScope) } : {}) }),
      };
    }
    return result;
  }
  return { getCompatibilityContext, prepareApplication };
}
