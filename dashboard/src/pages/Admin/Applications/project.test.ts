// @vitest-environment node
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { applicationProjectZip, draftKey, parseManifest } from "./project";
const manifest = {
  schema_version: 1,
  product: {
    application_id: "example.product",
    name: "Example",
    description: "",
    capabilities: ["chat", "memory"],
    agent_template: { system_prompt: "Synthetic template" },
    resource_requirements: {},
  },
  deployment: { enabled: true, resource_bindings: {}, configuration: {} },
};
describe("application export", () => {
  it("imports disabled, strips server metadata and rejects recursive secrets", () => {
    const parsed = parseManifest(
      JSON.stringify({
        ...manifest,
        product: {
          ...manifest.product,
          created_by: 17,
          connection_identity: { status: "pending" },
        },
      }),
    );
    expect(parsed.deployment.enabled).toBe(false);
    expect(parsed.product).not.toHaveProperty("created_by");
    expect(() =>
      parseManifest(
        JSON.stringify({
          ...manifest,
          deployment: {
            ...manifest.deployment,
            configuration: { nested: { clientSecret: "secret" } },
          },
        }),
      ),
    ).toThrow("MANIFEST_CONTAINS_SECRETS");
  });
  it("exports the SDK's own buildable template and private vendor package without account data", async () => {
    const exported = await applicationProjectZip(
      parseManifest(JSON.stringify(manifest)),
      new Blob(["synthetic-sdk"]),
    );
    const zip = await JSZip.loadAsync(await exported.arrayBuffer());
    const pkg = JSON.parse(await zip.file("package.json")!.async("string"));
    expect(pkg.dependencies["centaurai-wanx"]).toBe(
      "file:vendor/centaurai-wanx.tgz",
    );
    expect(await zip.file("vendor/centaurai-wanx.tgz")!.async("string")).toBe(
      "synthetic-sdk",
    );
    expect(await zip.file("src/product.ts")!.async("string")).toContain(
      '"example.product"',
    );
    expect(await zip.file("electron/main.ts")!.async("string")).toContain(
      "application_id: applicationId",
    );
    expect(
      Object.keys(zip.files).some((path) =>
        /credentials|private-memory|user-record/.test(path),
      ),
    ).toBe(false);
  });
  it("keeps drafts distinct across box, account and product", () => {
    const keys = [
      draftKey("https://a.test", 1, "a"),
      draftKey("https://b.test", 1, "a"),
      draftKey("https://a.test", 2, "a"),
      draftKey("https://a.test", 1, "b"),
    ];
    expect(new Set(keys).size).toBe(4);
  });
});
