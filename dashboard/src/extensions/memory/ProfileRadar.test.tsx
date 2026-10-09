import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { memoryDashboardApi } from "../../api/modules/memoryDashboard";
import { makeAtom, makeEntity } from "../../test/memoryFixtures";
import ProfileRadar, { radarPosition } from "./ProfileRadar";

vi.mock("../../api/modules/memoryDashboard", () => {
  const api = {
    terminalAboutMe: vi.fn(),
    terminalCurrentFocus: vi.fn(),
    terminalThingsYouToldMe: vi.fn(),
    terminalEntities: vi.fn(),
  };
  return { default: api, memoryDashboardApi: api };
});
const api = vi.mocked(memoryDashboardApi);
beforeEach(() => {
  vi.clearAllMocks();
  api.terminalAboutMe.mockResolvedValue({
    items: [
      makeAtom({
        id: "pref",
        assertion: "偏好简洁的回答",
        verbatim_quote: "回答简洁一点",
        entity_id: "owner",
      }),
    ],
  });
  api.terminalCurrentFocus.mockResolvedValue({
    items: [makeAtom({ id: "task", assertion: "准备阅读访谈" })],
  });
  api.terminalThingsYouToldMe.mockResolvedValue({
    items: [makeAtom({ id: "fact", assertion: "负责产品设计" })],
  });
  api.terminalEntities.mockResolvedValue({
    items: [makeEntity({ id: "project", canonical_name: "阅读项目" })],
  });
});

describe("original profile visualization", () => {
  it("renders four original profile categories and opens their source through the original library", async () => {
    const navigate = vi.fn();
    render(<ProfileRadar agentId="a" onViewAll={navigate} />);
    const graph = await screen.findByRole("group", {
      name: "profileRadar.title",
    });
    expect(within(graph).getAllByRole("button")).toHaveLength(4);
    fireEvent.keyDown(
      within(graph).getByRole("button", { name: "偏好简洁的回答" }),
      { key: "Enter" },
    );
    expect(await screen.findByText("回答简洁一点")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "profileRadar.source" }),
    );
    expect(navigate).toHaveBeenCalledWith("owner");
    expect(api.terminalAboutMe).toHaveBeenCalledWith("a", 12);
  });
  it("does not fabricate points and identifies failed categories separately from empty ones", async () => {
    api.terminalAboutMe.mockRejectedValue(new Error("unavailable"));
    api.terminalCurrentFocus.mockResolvedValue({ items: [] });
    api.terminalThingsYouToldMe.mockResolvedValue({ items: [] });
    api.terminalEntities.mockResolvedValue({ items: [] });
    render(<ProfileRadar agentId="a" />);
    expect(await screen.findByText("profileRadar.error")).toBeVisible();
    expect(screen.getByText("profileRadar.empty")).toBeVisible();
    expect(
      within(
        screen.getByRole("group", { name: "profileRadar.title" }),
      ).queryAllByRole("button"),
    ).toHaveLength(0);
  });
  it("does not leak a late profile response across experts", async () => {
    let resolve!: (v: { items: ReturnType<typeof makeAtom>[] }) => void;
    api.terminalAboutMe.mockImplementation((aid) =>
      aid === "a"
        ? new Promise((done) => {
            resolve = done;
          })
        : Promise.resolve({
            items: [makeAtom({ assertion: "专家 B 的画像" })],
          }),
    );
    const { rerender } = render(<ProfileRadar agentId="a" />);
    rerender(<ProfileRadar agentId="b" />);
    await screen.findAllByText("专家 B 的画像");
    resolve({ items: [makeAtom({ assertion: "专家 A 的迟到数据" })] });
    await waitFor(() =>
      expect(screen.queryByText("专家 A 的迟到数据")).not.toBeInTheDocument(),
    );
  });
  it("keeps geometric positions stable without accepting a confidence or alignment score", () => {
    expect(radarPosition("id", "aboutMe")).toEqual(
      radarPosition("id", "aboutMe"),
    );
    expect(radarPosition("id", "aboutMe")).not.toEqual(
      radarPosition("id", "entities"),
    );
  });
});

it("opens the exact original atom when embedded in a compact Zhijun profile", async () => {
  const source = vi.fn();
  render(<ProfileRadar agentId="own" compact onPointSource={source} />);
  const graph = await screen.findByRole("group", {
    name: "profileRadar.title",
  });
  fireEvent.click(
    within(graph).getByRole("button", { name: "偏好简洁的回答" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "profileRadar.source" }));
  expect(source).toHaveBeenCalledWith({ id: "pref", layer: "atom" });
});
