import { createHash } from "node:crypto";

/**
 * 从应用名（中文）派生 DSH preset id。
 *
 * DSH 的 PRESET_ID 约束是 /^[a-z0-9][a-z0-9-]*$/（目录名即 id），中文名不能直接
 * 做目录名。preset.yml 里的 name 仍是中文显示名；这里的 id 只做目录名。
 * 用 sha256 前 10 位保证确定性与唯一性，前缀 app- 符合约束。
 */
export function slugFromName(name: string): string {
  const h = createHash("sha256").update(name).digest("hex").slice(0, 10);
  return `app-${h}`;
}
