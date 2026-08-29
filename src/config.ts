import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * 万象的本地配置。
 *
 * 放在用户目录而不是项目里：桌面应用是双击启动的，没有 shell 环境变量可用；
 * 而且 key 不该跟代码待在一起，免得哪天被顺手提交。文件权限收到 0600。
 */
export interface WanxiangConfig {
  deepseekApiKey?: string;
  /** 默认 https://api.deepseek.com，走网关时覆盖 */
  baseUrl?: string;
  /** 默认 deepseek-chat */
  model?: string;
}

/**
 * 配置文件位置。写成函数而不是常量：常量在模块加载那一刻就定死了，
 * 之后再改 WANXIANG_CONFIG 不生效——测试和「运行时切换配置」都会被这一点坑到。
 */
export function configPath(): string {
  return process.env.WANXIANG_CONFIG ?? join(homedir(), ".config", "wanxiang", "config.json");
}

export function readConfig(): WanxiangConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(), "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const obj = parsed as Record<string, unknown>;
    return {
      deepseekApiKey: str(obj.deepseekApiKey),
      baseUrl: str(obj.baseUrl),
      model: str(obj.model),
    };
  } catch {
    return {};
  }
}

export function writeConfig(patch: WanxiangConfig): WanxiangConfig {
  const next: WanxiangConfig = { ...readConfig(), ...patch };
  const target = configPath();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(next, null, 2) + "\n", "utf-8");
  try {
    chmodSync(target, 0o600);
  } catch {
    // 某些文件系统不支持改权限，不该因此拦住保存。
  }
  return next;
}

/**
 * 取当前生效的 key。环境变量优先——手动 `export` 过的人应该说了算，
 * 配置文件是给双击启动的桌面应用兜底的。
 */
export function resolveKey(): string | undefined {
  return process.env.DEEPSEEK_API_KEY?.trim() || readConfig().deepseekApiKey;
}

export function resolveBaseUrl(): string | undefined {
  return process.env.DEEPSEEK_BASE_URL?.trim() || readConfig().baseUrl;
}

export function resolveModel(): string | undefined {
  return process.env.DEEPSEEK_MODEL?.trim() || readConfig().model;
}

/** key 从哪来的。界面上要说清楚，免得用户改了配置却被环境变量盖着还纳闷。 */
export function keySource(): "env" | "config" | "none" {
  if (process.env.DEEPSEEK_API_KEY?.trim()) return "env";
  if (readConfig().deepseekApiKey) return "config";
  return "none";
}

/** 只给界面看的遮罩形式，永远不把完整 key 送回前端。 */
export function maskKey(key: string): string {
  if (key.length <= 10) return "•".repeat(key.length);
  return `${key.slice(0, 6)}${"•".repeat(8)}${key.slice(-4)}`;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}
