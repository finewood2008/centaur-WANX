import semver from "semver";

export function validateVersion(value) {
  if (typeof value !== "string" || value.length > 64 || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(value) || !semver.valid(value))
    throw Object.assign(new Error("INVALID_APPLICATION_VERSION"), { code: "INVALID_APPLICATION_VERSION" });
  return value;
}

export function compareVersions(left, right) {
  return semver.compare(validateVersion(left), validateVersion(right));
}
