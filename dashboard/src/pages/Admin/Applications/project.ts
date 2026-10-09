import JSZip from "jszip";
import {
  projectTemplates,
  type ApplicationManifest,
  type ProductDefinition,
} from "centaurai-wanx/browser";

export function productDefinition(
  product: ProductDefinition,
): ProductDefinition {
  return {
    application_id: product.application_id,
    name: product.name,
    description: product.description,
    capabilities: [...product.capabilities],
    agent_template: product.agent_template,
    resource_requirements: product.resource_requirements,
  };
}

export function parseManifest(raw: string): ApplicationManifest {
  const input = JSON.parse(raw) as ApplicationManifest;
  if (
    input.schema_version !== 1 ||
    !input.product ||
    !input.deployment ||
    !/^[a-z][a-z0-9.-]{0,63}$/.test(input.product.application_id) ||
    input.product.application_id === "wanx"
  )
    throw new Error("INVALID_APPLICATION_MANIFEST");
  const manifest = {
    schema_version: 1,
    product: productDefinition(input.product),
    deployment: {
      enabled: false,
      resource_bindings: input.deployment.resource_bindings,
      configuration: input.deployment.configuration,
    },
  } as ApplicationManifest;
  assertCredentialFree(manifest);
  return manifest;
}

export function assertCredentialFree(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .replace(/-/g, "_");
    if (
      /password|(^|_)(token|secret|api_key|private_key|credentials?|access_token|refresh_token|access_key|authorization)(_|$)/i.test(
        normalized,
      )
    )
      throw new Error("MANIFEST_CONTAINS_SECRETS");
    assertCredentialFree(child);
  }
}

export async function applicationProjectZip(
  manifest: ApplicationManifest,
  sdk: Blob,
): Promise<Blob> {
  assertCredentialFree(manifest);
  const zip = new JSZip();
  for (const [path, content] of Object.entries(projectTemplates(manifest)))
    zip.file(path, content);
  zip.file("vendor/centaurai-wanx.tgz", await sdk.arrayBuffer());
  return zip.generateAsync({ type: "blob" });
}

export function downloadFile(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Box origin and login identity are part of every local draft's ownership. */
export function draftKey(
  origin: string,
  userId: number,
  applicationId: string,
): string {
  return `wanx:application-draft:v1:${encodeURIComponent(
    origin,
  )}:${userId}:${applicationId}`;
}
