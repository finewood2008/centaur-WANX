// Main-process only. Renderer/Host SDK callers never provide this override.
export function validateApplicationConnectionOptions(options) {
  if (options === undefined) return undefined;
  if (!options || typeof options !== "object" || Array.isArray(options) ||
      Object.keys(options).length !== 1 || !Object.hasOwn(options, "backendProductId") ||
      !["wanx", "super-advisory"].includes(options.backendProductId))
    throw Object.assign(new Error("BOX_APPLICATION_SCOPE_FORBIDDEN"), { code: "BOX_APPLICATION_SCOPE_FORBIDDEN" });
  return Object.freeze({ backendProductId: options.backendProductId });
}
