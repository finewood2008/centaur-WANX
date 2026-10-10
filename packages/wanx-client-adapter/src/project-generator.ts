import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ApplicationManifest } from "./application-contracts.js";
import { projectTemplates } from "./project-templates.js";
import { WanxError } from "./errors.js";

export interface GenerateApplicationProjectOptions {
  readonly directory: string;
  readonly manifest: ApplicationManifest;
  /** A local npm pack artifact; the private SDK is not fetched from a public registry. */
  readonly sdkTarball: string;
}
/** Main/Node only. Generated projects contain no account records or runtime secrets. */
export async function generateWanxApplicationProject(options: GenerateApplicationProjectOptions): Promise<{ directory: string; files: readonly string[] }> {
  const { product, deployment } = options.manifest;
  if (options.manifest.schema_version !== 1 || !/^[a-z][a-z0-9.-]{0,63}$/u.test(product.application_id) || product.application_id === "wanx") throw new WanxError("INVALID_APPLICATION_MANIFEST");
  const manifest: ApplicationManifest = JSON.parse(JSON.stringify({
    schema_version: 1,
    product: { application_id: product.application_id, name: product.name, description: product.description, capabilities: [...product.capabilities], agent_template: product.agent_template, resource_requirements: product.resource_requirements },
    deployment: { enabled: deployment.enabled, resource_bindings: deployment.resource_bindings, configuration: deployment.configuration },
  }));
  const inspect = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.replace(/([a-z])([A-Z])/gu, "$1_$2").replace(/-/gu, "_");
      if (/password|(^|_)(token|secret|api_key|private_key|credentials?|access_token|refresh_token|access_key|authorization)(_|$)/iu.test(normalized)) throw new WanxError("MANIFEST_CONTAINS_SECRETS");
      inspect(item);
    }
  };
  inspect(manifest);
  const directory = resolve(options.directory);
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length) throw new WanxError("PROJECT_DIRECTORY_NOT_EMPTY");
  const tarball = resolve(options.sdkTarball);
  if (!basename(tarball).endsWith(".tgz")) throw new WanxError("INVALID_SDK_TARBALL");
  const templates = projectTemplates(manifest);
  await mkdir(join(directory, "vendor"));
  await copyFile(tarball, join(directory, "vendor", "centaurai-wanx.tgz"));
  for (const [file, content] of Object.entries(templates)) {
    await mkdir(resolve(directory, file, ".."), { recursive: true });
    await writeFile(join(directory, file), content, { flag: "wx" });
  }
  return { directory, files: [...Object.keys(templates), "vendor/centaurai-wanx.tgz"] };
}
