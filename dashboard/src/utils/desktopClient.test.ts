import { describe, expect, it, afterEach } from "vitest";
import { buildNavSections, isGroupedNavKey } from "../layouts/sidebarNav";
import {
  currentBoxScope,
  isWanxDesktopClient,
  withClientTabs,
} from "./desktopClient";
afterEach(() => {
  delete window.wanxDesktop;
});
describe("WANX computer client boundaries", () => {
  it("shows both peer client tabs without adding them to the server feature list", () => {
    const server = buildNavSections(null, { desktopClient: false });
    expect(
      server.flatMap((group) => group.items.map((item) => item.key)),
    ).not.toContain("boxes");
    expect(
      server.flatMap((group) => group.items.map((item) => item.key)),
    ).not.toContain("applications");
    const client = buildNavSections(null, { desktopClient: true });
    expect(client[0].items.slice(0, 2).map((item) => item.key)).toEqual([
      "boxes",
      "applications",
    ]);
    expect(isGroupedNavKey("applications")).toBe(false);
  });
  it("scopes drafts to the selected SDK device rather than the local gateway origin", () => {
    window.wanxDesktop = {
      currentBoxId: () => "consumer-device-a",
    } as NonNullable<Window["wanxDesktop"]>;
    expect(isWanxDesktopClient()).toBe(true);
    expect(currentBoxScope()).toBe("consumer-device-a");
    window.wanxDesktop = {
      currentBoxId: () => "consumer-device-b",
    } as NonNullable<Window["wanxDesktop"]>;
    expect(currentBoxScope()).toBe("consumer-device-b");
  });
  it("keeps the two client tabs visible when restoring a saved server sidebar layout", () => {
    const catalog = buildNavSections(null, { desktopClient: true });
    const serverPreference = [
      {
        items: catalog[0].items.filter(
          (item) => !["boxes", "applications"].includes(item.key),
        ),
      },
    ];
    expect(
      withClientTabs(serverPreference, catalog)[0]
        .items.slice(0, 2)
        .map((item) => item.key),
    ).toEqual(["boxes", "applications"]);
  });
});
