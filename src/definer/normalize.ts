import type { Capability } from "../appspec/schema";

const VALID_CAPABILITIES: Capability[] = [
  "search",
  "summarize",
  "extract",
  "compose",
  "notify",
  "api_call",
  "browse",
];

/** 模型常见「自由命名」→ 标准枚举的映射。 */
const CAPABILITY_ALIASES: Record<string, Capability> = {
  // browse 类
  fetch_web_content: "browse",
  browse_web: "browse",
  web_browse: "browse",
  fetch: "browse",
  parse_rss: "browse",
  read_web: "browse",
  read_url: "browse",
  scrape: "browse",
  crawl: "browse",
  // search 类
  web_search: "search",
  search_web: "search",
  lookup: "search",
  filter_by_keywords: "search",
  // summarize 类
  summarize_text: "summarize",
  summary: "summarize",
  digest: "summarize",
  // extract 类
  extract_data: "extract",
  extraction: "extract",
  parse: "extract",
  // compose 类
  generate_report: "compose",
  generate_daily_report: "compose",
  write: "compose",
  write_report: "compose",
  compose_text: "compose",
  generate: "compose",
  // notify 类
  send_notification: "notify",
  notify_user: "notify",
  // api_call 类
  call_api: "api_call",
  api: "api_call",
  http_request: "api_call",
};

/**
 * 对 LLM 输出的原始对象做确定性规范化，再做 schema 校验：
 * 1. capabilities 把自由命名映射回标准枚举，去重；
 * 2. memory_binding.read 缺失时默认 ["*"]；
 * 3. delivery.form 缺失时用 goal 兜底；
 * 4. workflow 允许模型直接给数组（而非 {steps}），boundaries 允许给字符串；
 * 5. delivery.output 说要写记忆但没绑定可写库时，降为 chat（否则产出自相矛盾的指令）。
 * 未知/非法值保留，交由校验器报错（触发修复重试）。
 */
export function normalizeAppSpec(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const obj = input as Record<string, unknown>;

  if (Array.isArray(obj.capabilities)) {
    const mapped = (obj.capabilities as unknown[]).map((c) => {
      if (typeof c !== "string") return c;
      if ((VALID_CAPABILITIES as string[]).includes(c)) return c;
      const key = c.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
      return CAPABILITY_ALIASES[key] ?? c;
    });
    obj.capabilities = [...new Set(mapped)];
  }

  const mb = obj.memory_binding as Record<string, unknown> | undefined;
  if (mb && !Array.isArray(mb.read)) {
    mb.read = ["*"];
  }

  // params 规范化：模型常漏 type、用 description 代替 label
  if (Array.isArray(obj.params)) {
    obj.params = (obj.params as unknown[]).map((p) => {
      if (typeof p !== "object" || p === null) return p;
      const param = { ...(p as Record<string, unknown>) };
      if (param.type === undefined) {
        if (typeof param.default === "number") param.type = "number";
        else if (typeof param.default === "boolean") param.type = "boolean";
        else param.type = "string";
      }
      if (param.label === undefined && typeof param.description === "string") {
        param.label = param.description;
      }
      if (
        param.type === "enum" &&
        (!Array.isArray(param.options) || (param.options as unknown[]).length === 0)
      ) {
        param.type = "string";
      }
      return param;
    });
  }

  // 模型常把 workflow 直接写成数组，或写成 { steps: "一句话" }
  if (Array.isArray(obj.workflow)) {
    obj.workflow = { steps: obj.workflow };
  } else if (obj.workflow && typeof obj.workflow === "object") {
    const wf = obj.workflow as Record<string, unknown>;
    if (typeof wf.steps === "string") wf.steps = [wf.steps];
  }

  if (typeof obj.boundaries === "string") {
    obj.boundaries = [obj.boundaries];
  }

  const delivery = obj.delivery as Record<string, unknown> | undefined;
  if (delivery && (typeof delivery.form !== "string" || delivery.form.trim() === "")) {
    delivery.form =
      typeof obj.goal === "string" && obj.goal.trim() !== ""
        ? `完成目标：${obj.goal}`
        : "按目标执行并汇报";
  }

  // output 声称要写记忆，却没有可写库 → 降为 chat。
  // 不降的话，persona 会写着「写入记忆库」但没说写哪，也没挂写工具。
  const writeList = mb && Array.isArray(mb.write) ? (mb.write as unknown[]) : [];
  if (delivery && writeList.length === 0 && (delivery.output === "memory" || delivery.output === "both")) {
    delivery.output = "chat";
  }

  return obj;
}
