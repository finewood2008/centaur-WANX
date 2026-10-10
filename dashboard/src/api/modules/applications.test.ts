import { beforeEach, expect, it, vi } from "vitest";
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../request", () => ({ request }));
import { createApplicationsSession } from "./applications";
import { canAccessPath } from "../../utils/permissions";
beforeEach(() => request.mockReset());
it("the real SDK serializes definition updates without mutable identity", async () => {
  request.mockResolvedValue({
    application_id: "example.product",
    name: "Example",
  });
  const client = createApplicationsSession();
  await client.applications.update("example.product", { name: "Updated" });
  expect(request).toHaveBeenCalledWith(
    "/admin/applications/example.product",
    expect.objectContaining({ method: "PATCH", body: '{"name":"Updated"}' }),
  );
  await expect(client.applications.get("example/product")).rejects.toThrow(
    "INVALID_PATH_PARAMETER",
  );
  await expect(
    client.applications.getProfile("example.product"),
  ).rejects.toThrow("OPERATION_NOT_ALLOWED");
  await client.close();
});
it("ordinary users cannot open application management, developers use the server's restricted facade", () => {
  expect(
    canAccessPath({ role: "user", permissions: [] }, "/admin/applications"),
  ).toBe(false);
  expect(
    canAccessPath(
      { role: "user", permissions: ["desktop"] },
      "/admin/applications",
    ),
  ).toBe(false);
  expect(
    canAccessPath(
      { role: "user", permissions: ["applications_develop"] },
      "/admin/applications",
    ),
  ).toBe(true);
});
