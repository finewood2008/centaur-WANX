import { request } from "../request";
import type {
  MBTIType,
  MBTITestQuestion,
  MBTITestResult,
  MBTIApplyResponse,
} from "../types";

function agentHeaders(agentId?: string): HeadersInit | undefined {
  if (!agentId) return undefined;
  return { "X-Octop-Agent-Id": agentId };
}

export const mbtiApi = {
  /** Get currently configured MBTI type from the active agent. */
  getCurrentMBTI: (agentId?: string) =>
    request<{ code: string; configured: boolean }>("/mbti/current", {
      headers: agentHeaders(agentId),
    }),

  /** List all 16 MBTI types. */
  listMBTITypes: (agentId?: string) =>
    request<MBTIType[]>("/mbti/types", { headers: agentHeaders(agentId) }),

  /** Get details for a single MBTI type. */
  getMBTIType: (code: string) => request<MBTIType>(`/mbti/types/${code}`),

  /** Get all 28 test questions. */
  getMBTITestQuestions: (agentId?: string) =>
    request<MBTITestQuestion[]>("/mbti/test/questions", {
      headers: agentHeaders(agentId),
    }),

  /** Submit test answers and get result. */
  submitMBTITest: (
    answers: Record<string, string>,
    autoApply = false,
    language = "zh",
    agentId?: string,
  ) =>
    request<MBTITestResult>("/mbti/test/submit", {
      method: "POST",
      body: JSON.stringify({
        answers,
        auto_apply: autoApply,
        language,
      }),
      headers: agentHeaders(agentId),
    }),

  /** Apply a persona; Zhijun also accepts _default to restore natural style. */
  applyMBTIType: (code: string, language = "zh", agentId?: string) =>
    request<MBTIApplyResponse>("/mbti/apply", {
      method: "POST",
      body: JSON.stringify({ code, language }),
      headers: agentHeaders(agentId),
    }),
};
