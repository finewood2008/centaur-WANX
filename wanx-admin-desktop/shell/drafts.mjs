import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
export function validateProductDraft(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("草稿必须是产品定义");
  const allowed = new Set([
    "application_id",
    "name",
    "description",
    "capabilities",
    "agent_template",
    "resource_requirements",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error("草稿只保存产品定义字段");
  const inspect = (item) => {
    if (typeof item === "string" && /^\s*[\[{]/.test(item)) {
      try {
        inspect(JSON.parse(item));
      } catch (error) {
        if (error.message.includes("草稿不能")) throw error;
      }
    }
    if (!item || typeof item !== "object") return;
    for (const [key, nested] of Object.entries(item)) {
      if (
        /password|(^|[_-])(token|secret|api[_-]key|private[_-]key|credential|authorization)([_-]|$)/i.test(
          key,
        )
      )
        throw new Error("草稿不能保存凭据或密钥");
      inspect(nested);
    }
  };
  inspect(value);
  if (JSON.stringify(value).length > 1048576)
    throw new Error("产品草稿超过 1 MiB");
  return value;
}
export function createDraftStore(file) {
  let writing = Promise.resolve();
  const key = (scope) =>
    JSON.stringify([
      scope.boxId,
      scope.userId,
      scope.applicationId || "new-product",
    ]);
  const read = async () => {
    try {
      const data = JSON.parse(await readFile(file, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("草稿目录格式无效");
      return data;
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  };
  return {
    async get(scope) {
      return (await read())[key(scope)] || null;
    },
    async put(scope, value) {
      const draft = validateProductDraft(value);
      const work = writing.then(async () => {
        const data = await read();
        data[key(scope)] = {
          product: draft,
          saved_at: Math.floor(Date.now() / 1000),
        };
        await mkdir(dirname(file), { recursive: true });
        const temporary = `${file}.tmp`;
        await writeFile(temporary, JSON.stringify(data, null, 2), {
          mode: 0o600,
        });
        await rename(temporary, file);
        return { saved_at: data[key(scope)].saved_at };
      });
      writing = work.catch(() => {});
      return work;
    },
  };
}
