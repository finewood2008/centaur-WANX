/** Native Teams brainstorming and owner-scoped Zhijun source contracts. */
export interface BrainstormSource {
  readonly id: string; readonly kind: "memory" | "ontology" | "knowledge" | "history";
  readonly title: string; readonly text: string; readonly version: string; readonly provenance: string;
}
export interface BrainstormContext { readonly sources: readonly BrainstormSource[]; readonly text: string; readonly notices: readonly string[]; }
export interface MeetingOption {
 readonly proposal?: ProposalRef | null;
  readonly label: string; readonly detail: string; readonly effect: "respond" | "adopt" | "revisit";
}
export interface MeetingDecision {
 readonly board_version?: number | null;
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
 readonly council?: CouncilBoard | null; readonly matter_id?: string; readonly continued_from?: string | null;
 readonly referenced_meetings?: readonly string[]; readonly inherited_background?: readonly string[];
 readonly recommended_roster?: readonly { readonly agent_id: string; readonly reason: string }[];
 readonly confirmed_roster?: readonly string[];
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
 readonly capabilities?: readonly string[];
  readonly team_id: string | null; readonly host_model: string | null; readonly models: readonly string[];
  readonly members: readonly BrainstormMember[];
  readonly experts: readonly BrainstormExpert[];
}
export interface BrainstormControl {
 readonly participant_ids?: readonly string[]; readonly target_agent_id?: string; readonly proposal?: ProposalRef;
  readonly action: "defer" | "pause" | "resume" | "end" | "summarize" | "sources" | "respond" | "start" | "revise" | "agenda" | "adopt";
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
 readonly wanxBrainstormSessionsCreate: { readonly request: { readonly body: { readonly topic: string; readonly council_enabled?: boolean; readonly continued_from?: string; readonly referenced_meetings?: readonly string[]; readonly context_enabled?: boolean; readonly expert_ids?: readonly string[] } }; readonly responseBody: BrainstormSession };
 readonly wanxBrainstormSessionGet: { readonly request: { readonly path: { readonly thread_id: string } }; readonly responseBody: BrainstormSession };
 readonly wanxBrainstormSessionControl: { readonly request: { readonly path: { readonly thread_id: string }; readonly body: BrainstormControl }; readonly responseBody: BrainstormSession };
}

export interface ProposalRef { readonly proposal_id: string; readonly version: number; }
export interface CouncilIssue { readonly id: string; readonly question: string; readonly status: 'discussing' | 'presented' | 'deferred' | 'decided'; }
export interface ProposalVersion { readonly version: number; readonly title: string; readonly advice: string; readonly basis: string; readonly cost: string; readonly change_reason: string; readonly message_id: string; readonly source_ids: readonly string[]; readonly context_version: number; }
export interface CouncilProposal { readonly id: string; readonly issue_id: string; readonly author_id: string; readonly status: 'active' | 'deferred' | 'needs_review' | 'adopted'; readonly versions: readonly ProposalVersion[]; }
export interface CouncilReview { readonly id: string; readonly issue_id: string; readonly proposal_id: string; readonly version: number; readonly author_id: string; readonly stance: 'support' | 'concern' | 'question'; readonly point: string; readonly message_id: string; }
export interface CouncilBoard {
 readonly version: number; readonly context_version: number; readonly active_issue_id: string;
 readonly issues: readonly CouncilIssue[]; readonly proposals: readonly CouncilProposal[]; readonly reviews: readonly CouncilReview[];
 readonly speeches: readonly { readonly message_id: string; readonly issue_id: string; readonly author_id: string; readonly responds_to: string }[];
 readonly changes: readonly { readonly id: string; readonly kind: string; readonly text: string; readonly issue_id: string; readonly proposal_id: string; readonly message_id: string }[];
 readonly recommendation: ProposalRef | null; readonly adopted: ProposalRef | null;
 readonly pending_input: string; readonly input_acknowledgment: string; readonly next_step: string;
}
