/** Native Teams brainstorming and owner-scoped Zhijun source contracts. */
export interface BrainstormSource {
  readonly id: string; readonly kind: "memory" | "ontology" | "knowledge" | "history";
  readonly title: string; readonly text: string; readonly version: string; readonly provenance: string;
}
export interface BrainstormContext { readonly sources: readonly BrainstormSource[]; readonly text: string; readonly notices: readonly string[]; }
export interface MeetingOption {
  readonly label: string; readonly detail: string; readonly effect: "respond" | "adopt" | "revisit";
}
export interface MeetingDecision {
  readonly id: string; readonly kind: "intake" | "agenda" | "judgment" | "verdict";
  readonly question: string; readonly options: readonly MeetingOption[];
}
export interface BrainstormExpert {
 readonly id: string; readonly name: string; readonly description: string; readonly source: "builtin" | "skillhub"; readonly recommended: boolean;
}
export interface BrainstormMember {
 readonly agent_id: string; readonly name: string; readonly model: string | null; readonly expert_id: string; readonly description: string;
}
export interface MeetingReportDraft {
 readonly overview: string; readonly key_points: readonly string[]; readonly disagreements: readonly string[];
 readonly actions: readonly { readonly task: string; readonly owner: string; readonly timing: string }[];
 readonly open_questions: readonly string[];
}
export interface MeetingReport {
 readonly thread_id: string; readonly title: string; readonly generated_at: string;
 readonly outcome: "adopted" | "unresolved"; readonly markdown: string;
}
export interface BrainstormSession {
  readonly participants: readonly BrainstormMember[];
  readonly thread_id: string; readonly team_id: string; readonly user_id: number; readonly title: string;
  readonly status: "running" | "waiting" | "paused" | "ended" | "interrupted";
  readonly context_enabled: boolean; readonly excluded_source_ids: readonly string[]; readonly context: BrainstormContext;
  readonly ideas: readonly string[]; readonly directions: readonly string[]; readonly questions: readonly string[];
  readonly summary: string; readonly turns: number; readonly revision: number;
  readonly phase: "intake" | "agenda" | "deliberation" | "decision" | "closed";
  readonly agenda_confirmed: boolean; readonly goal: string; readonly constraints: readonly string[];
  readonly agenda: string; readonly brief: string; readonly decision: MeetingDecision | null;
  readonly judgments: readonly { readonly question: string; readonly answer: string }[];
  readonly intake_answers: number; readonly ruling: string;
  readonly report_draft: MeetingReportDraft | null; readonly report: MeetingReport | null;
}
export interface BrainstormProfile {
  readonly team_id: string | null; readonly host_model: string | null; readonly models: readonly string[];
  readonly members: readonly BrainstormMember[];
  readonly experts: readonly BrainstormExpert[];
}
export interface BrainstormControl {
  readonly action: "pause" | "resume" | "end" | "summarize" | "sources" | "respond" | "start" | "revise" | "agenda" | "adopt";
  readonly text?: string; readonly decision_id?: string; readonly option_index?: number; readonly revision?: number;
  readonly context_enabled?: boolean; readonly excluded_source_ids?: readonly string[];
}
export interface BrainstormOperations {
 readonly wanxBrainstormReportGet: { readonly request: { readonly path: { readonly thread_id: string } }; readonly responseBody: MeetingReport };
 readonly wanxBrainstormReportDocument: { readonly request: { readonly path: { readonly thread_id: string } }; readonly responseBody: Uint8Array };
 readonly wanxBrainstormExpertImport: { readonly request: { readonly path: { readonly slug: string } }; readonly responseBody: BrainstormExpert };
 readonly wanxBrainstormProfileGet: { readonly request: {}; readonly responseBody: BrainstormProfile };
 readonly wanxBrainstormProfileConfigure: { readonly request: { readonly body: { readonly expert_ids?: readonly string[]; readonly expert_models?: Readonly<Record<string, string>> } }; readonly responseBody: BrainstormProfile };
 readonly wanxBrainstormSessionsList: { readonly request: {}; readonly responseBody: readonly BrainstormSession[] };
 readonly wanxBrainstormSessionsCreate: { readonly request: { readonly body: { readonly topic: string; readonly context_enabled?: boolean; readonly expert_ids?: readonly string[] } }; readonly responseBody: BrainstormSession };
 readonly wanxBrainstormSessionGet: { readonly request: { readonly path: { readonly thread_id: string } }; readonly responseBody: BrainstormSession };
 readonly wanxBrainstormSessionControl: { readonly request: { readonly path: { readonly thread_id: string }; readonly body: BrainstormControl }; readonly responseBody: BrainstormSession };
}
