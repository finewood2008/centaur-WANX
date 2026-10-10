import { beforeEach, expect, it, vi } from "vitest";
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../request", () => ({ request }));
import { mbtiApi } from "./mbti";

beforeEach(() => request.mockReset());
it("keeps catalogue and current selection scoped to the requested profile", async () => {
  await mbtiApi.listMBTITypes("my-zhijun");
  expect(request).toHaveBeenLastCalledWith("/mbti/types", {
    headers: { "X-Octop-Agent-Id": "my-zhijun" },
  });
  await mbtiApi.getCurrentMBTI("my-zhijun");
  expect(request).toHaveBeenLastCalledWith("/mbti/current", {
    headers: { "X-Octop-Agent-Id": "my-zhijun" },
  });
});
it("uses native apply for a type and the natural reset, without a conversation request", async () => {
  for (const code of ["INFJ", "_default"]) {
    await mbtiApi.applyMBTIType(code, "zh", "my-zhijun");
    expect(request).toHaveBeenLastCalledWith("/mbti/apply", {
      method: "POST",
      body: JSON.stringify({ code, language: "zh" }),
      headers: { "X-Octop-Agent-Id": "my-zhijun" },
    });
  }
  expect(request).toHaveBeenCalledTimes(2);
});
it("loads and scores the native questionnaire under the explicit profile without automatic apply", async () => {
  await mbtiApi.getMBTITestQuestions("my-zhijun");
  expect(request).toHaveBeenLastCalledWith("/mbti/test/questions", {
    headers: { "X-Octop-Agent-Id": "my-zhijun" },
  });
  const answers = { "1": "A", "2": "B" };
  await mbtiApi.submitMBTITest(answers, false, "zh", "my-zhijun");
  expect(request).toHaveBeenLastCalledWith("/mbti/test/submit", {
    method: "POST",
    body: JSON.stringify({ answers, auto_apply: false, language: "zh" }),
    headers: { "X-Octop-Agent-Id": "my-zhijun" },
  });
  expect(request).toHaveBeenCalledTimes(2);
});
