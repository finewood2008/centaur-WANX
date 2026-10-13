import "@testing-library/jest-dom/vitest";
import { Suspense } from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { routeConfigs } from "./index";

vi.mock("../components/NotFoundPage", () => ({
  default: () => <div>page-not-found</div>,
}));

describe("removed box management route", () => {
  it("shows not found instead of redirecting old box management URLs", async () => {
    render(
      <MemoryRouter initialEntries={["/boxes?wanx_client=remote"]}>
        <Suspense fallback={null}>
          <Routes>
            {routeConfigs.map((route) => (
              <Route
                key={route.path}
                path={route.path}
                element={route.element}
              />
            ))}
          </Routes>
        </Suspense>
      </MemoryRouter>,
    );
    expect(await screen.findByText("page-not-found")).toBeInTheDocument();
  });
});
