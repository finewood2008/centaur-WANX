import semver from "semver";

export function validateVersion(value) {
  if (typeof value !== "string" || value.length > 64 || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(value) || !semver.valid(value))
    throw Object.assign(new Error("INVALID_APPLICATION_VERSION"), { code: "INVALID_APPLICATION_VERSION" });
  return value;
}

export function compareVersions(left, right) {
  return semver.compare(validateVersion(left), validateVersion(right));
}

// Contract v2 deliberately supports only explicit stable-version comparator sets.
export function validateVersionRange(value) {
  const stable = "(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)";
  if (typeof value !== "string" || value.length > 256 ||
      !new RegExp(`^(?:>=|<=|>|<|=)?${stable}(?: (?:>=|<=|>|<|=)?${stable})*$`).test(value) ||
      !semver.validRange(value) || !semver.minVersion(value))
    throw Object.assign(new Error("APPLICATION_CONTRACT_UNSUPPORTED"), { code: "APPLICATION_CONTRACT_UNSUPPORTED" });
  return value;
}

// Resource releases guarantee forward compatibility, so only a stable floor is accepted.
export function validateResourceVersion(value) {
  if (typeof value !== "string" || value.length > 64 ||
      !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value) || !semver.valid(value) || value.split(".").some(part => Number(part) > 2147483647))
    throw Object.assign(new Error("APPLICATION_CONTRACT_UNSUPPORTED"), { code: "APPLICATION_CONTRACT_UNSUPPORTED" });
  return value;
}
