import "@testing-library/jest-dom/vitest";
import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../pages/Agent/Memory/Overview", () => ({
  default: () => <div>原生概览</div>,
}));
vi.mock("../../pages/Agent/Memory/ProfileOverview", () => ({
  default: () => <div>原生用户画像</div>,
}));
vi.mock("./ProfileRadar", () => ({ default: () => <div>画像雷达扩展</div> }));
vi.mock("../../api/modules/memoryDashboard", () => ({
  default: {
    statsCounts: vi.fn().mockResolvedValue({ candidates_pending: 0 }),
  },
}));
import MemoryPanel from "../../pages/Agent/Memory/MemoryPanel";

it("adds the radar only to the native profile tab and keeps the native overview", async () => {
  render(<MemoryPanel agentId="a" />);
  expect(await screen.findByText("原生概览")).toBeVisible();
  expect(screen.queryByText("画像雷达扩展")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: /用户画像/ }));
  expect(await screen.findByText("画像雷达扩展")).toBeVisible();
  expect(screen.getByText("原生用户画像")).toBeVisible();
});
