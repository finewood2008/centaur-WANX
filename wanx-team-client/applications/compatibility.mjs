import semver from "semver";
import { validateVersion, validateVersionRange, validateResourceVersion } from "./version.mjs";

const fail = code => Object.assign(new Error(code), { code });
const identifier = value => typeof value === "string" && /^[a-z][a-z0-9._-]{1,127}$/.test(value);
function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key)))
    throw fail("APPLICATION_CONTRACT_UNSUPPORTED");
}

/** A deliberately small, versioned dependency contract. Unknown requirements fail closed. */
export function validateCompatibility(value, protocolVersion = 2) {
  if (![2, 3].includes(protocolVersion)) throw fail("APPLICATION_CONTRACT_UNSUPPORTED");
  const dependencyField = protocolVersion === 3 ? "resourceDependencies" : "requiredExperts";
  exactKeys(value, ["backendProductId", "clientRange", "hostProtocolRange", "backendContracts", dependencyField, "localDataSchema"]);
  if (!identifier(value.backendProductId)) throw fail("APPLICATION_CONTRACT_UNSUPPORTED");
  validateVersionRange(value.clientRange);
  validateVersionRange(value.hostProtocolRange);
  if (!Array.isArray(value.backendContracts) || value.backendContracts.length > 32 ||
      !Array.isArray(value[dependencyField]) || value[dependencyField].length > 64) throw fail("APPLICATION_CONTRACT_UNSUPPORTED");
  const contracts = new Set(), experts = new Set();
  for (const contract of value.backendContracts) {
    exactKeys(contract, ["id", "range", "features"]);
    if (!identifier(contract.id) || contracts.has(contract.id) || !Array.isArray(contract.features) ||
        contract.features.length > 32 || contract.features.some(feature => !identifier(feature)) ||
        new Set(contract.features).size !== contract.features.length) throw fail("APPLICATION_CONTRACT_UNSUPPORTED");
    contracts.add(contract.id);
    validateVersionRange(contract.range);
  }
  for (const resource of protocolVersion === 3 ? value.resourceDependencies : []) {
    exactKeys(resource, ["kind", "resourceId", "minVersion"]);
    const key = `${resource.kind}:${resource.resourceId}`;
    if (!["expert", "skill-package"].includes(resource.kind) || typeof resource.resourceId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(resource.resourceId) || experts.has(key))
      throw fail("APPLICATION_CONTRACT_UNSUPPORTED");
    experts.add(key);
    validateResourceVersion(resource.minVersion);
  }
  for (const expert of protocolVersion === 2 ? value.requiredExperts : []) {
    exactKeys(expert, ["templateId", "versionRange", "role", "count", "required"]);
    const key = `${expert.templateId}:${expert.role}`;
    if (!identifier(expert.templateId) || !identifier(expert.role) || experts.has(key) ||
        !Number.isSafeInteger(expert.count) || expert.count < 1 || expert.count > 64 || typeof expert.required !== "boolean")
      throw fail("APPLICATION_CONTRACT_UNSUPPORTED");
    experts.add(key);
    validateVersionRange(expert.versionRange);
  }
  exactKeys(value.localDataSchema, ["readRange", "writeVersion"]);
  validateVersionRange(value.localDataSchema.readRange);
  validateVersion(value.localDataSchema.writeVersion);
  validateVersionRange(value.localDataSchema.writeVersion);
  if (!semver.satisfies(value.localDataSchema.writeVersion, value.localDataSchema.readRange))
    throw fail("APPLICATION_CONTRACT_UNSUPPORTED");
  // Canonical field order makes the signed descriptor/package comparison deterministic.
  return Object.freeze({
    backendProductId: value.backendProductId, clientRange: value.clientRange, hostProtocolRange: value.hostProtocolRange,
    backendContracts: value.backendContracts.map(({ id, range, features }) => ({ id, range, features: [...features] })),
    ...(protocolVersion === 3
      ? { resourceDependencies: value.resourceDependencies.map(({ kind, resourceId, minVersion }) => ({ kind, resourceId, minVersion })) }
      : { requiredExperts: value.requiredExperts.map(({ templateId, versionRange, role, count, required }) => ({ templateId, versionRange, role, count, required })) }),
    localDataSchema: { readRange: value.localDataSchema.readRange, writeVersion: value.localDataSchema.writeVersion },
  });
}

export function assertNoCriticalExtensions(value) {
  if (value.critical !== undefined && (!Array.isArray(value.critical) || value.critical.length))
    throw fail("APPLICATION_CONTRACT_UNSUPPORTED");
}

/** The caller supplies fresh evidence from the selected, authenticated box, never catalog claims. */
export function evaluateApplicationCompatibility(manifest, context = {}, { phase = "launch", trustedDataContinuity = false } = {}) {
  if (manifest.protocolVersion === 1) return { status: "legacy", code: "LEGACY_CONTRACT", checks: [] };
  const required = validateCompatibility(manifest.compatibility, manifest.protocolVersion), checks = [];
  const check = (condition, code, detail) => { if (!condition) checks.push({ code, ...(detail ? { detail } : {}) }); };
  check(semver.valid(context.clientVersion) && semver.satisfies(context.clientVersion, required.clientRange), "CLIENT_VERSION_INCOMPATIBLE");
  const hostVersion = Number.isSafeInteger(context.hostProtocol) ? `${context.hostProtocol}.0.0` : context.hostProtocol;
  check(semver.valid(hostVersion) && semver.satisfies(hostVersion, required.hostProtocolRange), "HOST_PROTOCOL_INCOMPATIBLE");
  // Reinstalling or selecting an older package can reuse the same profile even
  // when no previous installation record remains. Data compatibility belongs
  // to the data being opened, not only to the operation named "rollback".
  if (phase === "rollback" || context.localDataSchemaVersion != null || context.localDataPresent === true && !trustedDataContinuity) {
    check(semver.valid(context.localDataSchemaVersion) && semver.satisfies(context.localDataSchemaVersion, required.localDataSchema.readRange),
      context.localDataSchemaVersion ? "APPLICATION_DATA_SCHEMA_INCOMPATIBLE" : "APPLICATION_DATA_COMPATIBILITY_UNKNOWN");
  }
  const needsBackend = phase === "launch" || phase === "rollback" || phase === "candidate" && context.backendRequired === true;
  if (needsBackend) {
    const backend = context.backend;
    const observedAt = Date.parse(backend?.observedAt), now = Date.now();
    if (!backend || backend.schemaVersion !== 1 || backend.productId !== required.backendProductId ||
        !Number.isFinite(observedAt) || observedAt < now - 300000 || observedAt > now + 60000 || !backend.deviceId ||
        context.expectedDeviceId && backend.deviceId !== context.expectedDeviceId) {
      checks.push({ code: "BACKEND_CAPABILITIES_UNKNOWN" });
    } else {
      if (phase !== "candidate") check(backend.authorization?.status === "ready", backend.authorization?.code || "APP_ENTITLEMENT_REQUIRED");
      for (const contract of required.backendContracts) {
        const actual = Array.isArray(backend.contracts) ? backend.contracts.find(item => item?.id === contract.id) : null;
        check(actual && semver.valid(actual.version) && semver.satisfies(actual.version, contract.range) &&
          Array.isArray(actual.features) && contract.features.every(feature => actual.features.includes(feature)), "BACKEND_CONTRACT_INCOMPATIBLE", contract.id);
      }
      // Catalog/candidate checks do not require installed resources: installation
      // prepares exact published dependencies on the selected box.
      if (manifest.protocolVersion === 3 && phase !== "candidate") {
        for (const dependency of required.resourceDependencies) {
          const actual = Array.isArray(backend.resources) ? backend.resources.filter(item =>
            item?.kind === dependency.kind && item.resourceId === dependency.resourceId) : [];
          const binding = Array.isArray(backend.bindings) ? backend.bindings.filter(item =>
            item?.kind === dependency.kind && item.resourceId === dependency.resourceId) : [];
          const validVersion = value => { try { validateResourceVersion(value); return semver.gte(value, dependency.minVersion); } catch { return false; } };
          check(actual.length === 1 && actual[0].status === "ready" && validVersion(actual[0].version) &&
            binding.length === 1 && binding[0].version === actual[0].version &&
            typeof binding[0][dependency.kind === "expert" ? "instanceId" : "packageId"] === "string" &&
            /^[A-Za-z0-9_-]{1,128}$/.test(binding[0][dependency.kind === "expert" ? "instanceId" : "packageId"]),
            "APPLICATION_RESOURCES_NOT_READY", dependency.resourceId);
        }
      }
      for (const expert of (required.requiredExperts || []).filter(item => item.required)) {
        const actual = Array.isArray(backend.experts) ? backend.experts.find(item => item?.templateId === expert.templateId && item.role === expert.role) : null;
        const matching = Array.isArray(actual?.instances) ? actual.instances.filter(item => typeof item?.instanceId === "string" && item.instanceId && item.status === "ready" && semver.valid(item.version) &&
          semver.satisfies(item.version, expert.versionRange)) : [];
        check(actual?.status === "ready" && new Set(matching.map(item => item.instanceId)).size >= expert.count, actual?.code || "EXPERT_VERSION_UNKNOWN", expert.templateId);
      }
    }
  }
  return { status: checks.length ? "blocked" : needsBackend ? "ready" : "client_compatible", checks };
}

export async function assertApplicationCompatibility(manifest, { getCompatibilityContext, descriptor, phase = "launch", trustedDataContinuity = false } = {}) {
  if (manifest.protocolVersion === 1) return evaluateApplicationCompatibility(manifest);
  const context = await getCompatibilityContext?.({ manifest, descriptor, phase }) || {};
  // This option is supplied by the Host manager, never from remote context.
  const result = evaluateApplicationCompatibility(manifest, context, { phase, trustedDataContinuity });
  if (result.status === "blocked") throw Object.assign(fail(result.checks[0].code), { compatibility: result });
  return result;
}
