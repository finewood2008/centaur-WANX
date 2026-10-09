import "@testing-library/jest-dom/vitest";
import { Suspense } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { resolveSelectedKey, routeConfigs } from "./index";
vi.mock("../pages/Agent/Memory", () => ({
  default: () => <div>independent-memory-page</div>,
}));
function Location() {
  const loc = useLocation();
  return (
    <output>
      {loc.pathname}
      {loc.search}
      {loc.hash}
    </output>
  );
}
describe("Independent memory route", () => {
  it("redirects the old path without losing query or hash", async () => {
    render(
      <MemoryRouter
        initialEntries={["/personalization/memory?agent=private#detail"]}
      >
        <Suspense fallback={null}>
          <Routes>
            {routeConfigs
              .filter((r) =>
                ["/memory", "/personalization/memory"].includes(r.path),
              )
              .map((r) => (
                <Route key={r.path} path={r.path} element={r.element} />
              ))}
          </Routes>
        </Suspense>
        <Location />
      </MemoryRouter>,
    );
    await screen.findByText("independent-memory-page");
    expect(
      screen.getByText("/memory?agent=private#detail"),
    ).toBeInTheDocument();
    expect(resolveSelectedKey("/memory")).toBe("memory");
    expect(resolveSelectedKey("/personalization/memory")).toBe("memory");
    expect(resolveSelectedKey("/personalization/skills")).toBe(
      "personalization",
    );
  });
});
