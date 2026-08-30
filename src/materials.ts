import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workspaceDir } from "./runs";

/**
 * 「资料」——用户交给助手的东西。
 *
 * 直接落在 workspace 根下，因为那正是会话的 cwd：助手一睁眼就看得见，
 * 不用再教它去哪个子目录翻。（`.dsh/` 是隐藏目录，装工作手册用，不算资料。）
 *
 * 这一层是产品的另一半。没有它，助手被造出来却没有任何东西可读——
 * 实测那样跑一次要 80 秒，最后交回一份空清单，用户完全不知道问题出在哪。
 */
export interface Material {
  name: string;
  bytes: number;
  updatedAt: string;
}

/** 界面上能贴的最大单份资料。再大就不该走「粘一段进去」这个交互了。 */
export const MAX_MATERIAL_BYTES = 512 * 1024;

/**
 * 文件名清洗。名字直接进路径，也直接给用户看，所以两头都要管：
 * 挡住穿越和隐藏文件，同时保留中文——用户会用中文起名。
 */
export function safeName(input: string): string | null {
  // 分隔符换成空格后按段处理：纯由点组成的段（`.`、`..`）整段丢掉。
  // 只剥一次前导点是不够的——`../../etc` 会剩下 `.. etc`。
  const cleaned = String(input ?? "")
    .replace(/[\u0000-\u001F\u007F]/gu, "")
    .replace(/[/\\]/gu, " ")
    .split(/\s+/u)
    .filter((token) => token !== "" && !/^\.+$/u.test(token))
    .join(" ")
    .replace(/^\.+/u, "")
    .trim();
  if (cleaned === "" || cleaned.length > 80) return null;
  return /\.[a-zA-Z0-9]{1,8}$/u.test(cleaned) ? cleaned : `${cleaned}.md`;
}

/** 列出资料。`.dsh` 这种隐藏目录是万象自己的东西，不算资料。 */
export async function listMaterials(appsDir: string, slug: string): Promise<Material[]> {
  const dir = workspaceDir(appsDir, slug);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Material[] = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith(".")) continue;
    try {
      const s = await stat(join(dir, e.name));
      out.push({ name: e.name, bytes: s.size, updatedAt: s.mtime.toISOString() });
    } catch {
      // 读不到就跳过，不让一个坏文件挡住整个列表
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

export async function saveMaterial(
  appsDir: string,
  slug: string,
  name: string,
  text: string,
): Promise<Material | null> {
  const safe = safeName(name);
  if (safe === null) return null;
  if (Buffer.byteLength(text, "utf-8") > MAX_MATERIAL_BYTES) return null;
  const dir = workspaceDir(appsDir, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, safe), text, "utf-8");
  const s = await stat(join(dir, safe));
  return { name: safe, bytes: s.size, updatedAt: s.mtime.toISOString() };
}

export async function readMaterial(
  appsDir: string,
  slug: string,
  name: string,
): Promise<string | null> {
  const safe = safeName(name);
  if (safe === null) return null;
  try {
    return await readFile(join(workspaceDir(appsDir, slug), safe), "utf-8");
  } catch {
    return null;
  }
}

export async function deleteMaterial(appsDir: string, slug: string, name: string): Promise<boolean> {
  const safe = safeName(name);
  if (safe === null) return false;
  try {
    await rm(join(workspaceDir(appsDir, slug), safe), { force: true });
    return true;
  } catch {
    return false;
  }
}
