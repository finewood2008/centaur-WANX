import { validateApplicationManifest } from "../applications/manifest.mjs";

const fields = ["schemaVersion", "applicationId", "version", "resourceDependencies"];

/** Apply an Admin-exported build input before signing; it is never runtime authority. */
export function applyApplicationDependencyConfig(manifest, config) {
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      Object.keys(config).length !== fields.length || fields.some(field => !Object.hasOwn(config, field)) ||
      config.schemaVersion !== 1)
    throw new Error("应用依赖配置格式无效，请重新从 Admin 导出。");
  const original = validateApplicationManifest(manifest, { signed: true });
  if (original.protocolVersion !== 3)
    throw new Error("应用依赖配置仅支持协议 3，请先升级应用市场清单。");
  if (config.applicationId !== original.applicationId || config.version !== original.version)
    throw new Error("依赖配置中的应用 ID 或版本与当前发行不一致，请从对应版本重新导出。");
  const result = validateApplicationManifest({
    ...original,
    compatibility: { ...original.compatibility, resourceDependencies: config.resourceDependencies },
  }, { signed: true });
  if (result.compatibility.resourceDependencies.length && result.compatibility.backendProductId !== "wanx")
    throw new Error("动态专家与技能依赖仅支持 backendProductId=wanx，不能自动转换应用的盒端产品。");
  return result;
}
