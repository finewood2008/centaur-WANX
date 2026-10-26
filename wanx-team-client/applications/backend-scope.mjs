// Main-process only. Renderer/Host SDK callers never provide this override.
export function validateApplicationConnectionOptions(options) {
  if (options === undefined) return undefined;
  if (!options || typeof options !== "object" || Array.isArray(options) ||
      !Object.keys(options).length || Object.keys(options).some(key => !["backendProductId", "launchId", "capabilities"].includes(key)) ||
      (options.backendProductId !== undefined && !["wanx", "super-advisory"].includes(options.backendProductId)) ||
      (options.launchId !== undefined && (typeof options.launchId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(options.launchId)
        || Buffer.from(options.launchId, "base64url").toString("base64url") !== options.launchId)) ||
      (options.capabilities !== undefined && (!Array.isArray(options.capabilities) ||
        new Set(options.capabilities).size !== options.capabilities.length || options.capabilities.some(value =>
          !["identity.read", "experts.read", "experts.select", "http.request", "chat.stream", "files.upload"].includes(value)))))
    throw Object.assign(new Error("BOX_APPLICATION_SCOPE_FORBIDDEN"), { code: "BOX_APPLICATION_SCOPE_FORBIDDEN" });
  return Object.freeze({ ...(options.backendProductId !== undefined ? { backendProductId: options.backendProductId } : {}),
    ...(options.launchId !== undefined ? { launchId: options.launchId } : {}),
    ...(options.capabilities !== undefined ? { capabilities: Object.freeze([...options.capabilities]) } : {}) });
}
