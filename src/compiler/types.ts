import type { AppSpec, Domain, RetrievalStrategy } from "../appspec/schema";

/** DSH agent.cordis.yml 中的一个插件条目 */
export interface PluginEntry {
  id: string;
  name: string;
  config?: Record<string, unknown>;
  disabled?: boolean;
}

/** 编译器输出：一个完整的应用包（对应 DSH 一个 preset） */
export interface AppPackage {
  preset: {
    name: string;
    description: string;
    order: number;
    agentCordis: PluginEntry[];
  };
  memoryBinding: {
    read: string[];
    write: string[];
    retrieval: RetrievalStrategy;
  };
  /** 生成的技能文件（相对应用目录的路径 → 内容）。workflow 为空时为 null。 */
  skill: { path: string; content: string } | null;
  meta: {
    name: string;
    description: string;
    schema_version: string;
    domain: Domain;
    goal: string;
    capabilities: AppSpec["capabilities"];
    memory_binding: AppSpec["memory_binding"];
    delivery: AppSpec["delivery"];
    workflow: AppSpec["workflow"];
    boundaries: AppSpec["boundaries"];
    params: AppSpec["params"];
  };
}
