import { access, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyEnvelope } from "../applications/descriptor.mjs";
import { validateApplicationManifest } from "../applications/manifest.mjs";

const invalid = () => Object.assign(new Error("APPLICATION_RECORD_INVALID"), { code: "APPLICATION_RECORD_INVALID" });

export async function launchInstalledApplication({
  app, applicationRoot, installPath, environment = process.env, trustedKeys = {},
  send = message => process.send?.(message, () => {}),
  receive = listener => process.on("message", listener),
  load = entry => import(pathToFileURL(entry).href),
}) {
  if (!environment.WANX_HOST_LAUNCH_ID || !environment.WANX_HOST_TOKEN || !environment.WANX_HOST_CLIENT_APPLICATION_ID)
    throw invalid();
  const root = await realpath(applicationRoot);
  const directory = await realpath(installPath);
  if (path.dirname(path.dirname(directory)) !== root) throw invalid();
  const record = JSON.parse(await readFile(path.join(directory, ".wanx-install.json"), "utf8"));
  const manifest = validateApplicationManifest(record, { allowLegacyVersion: true, signed: Boolean(record.envelope) });
  if (manifest.applicationId !== environment.WANX_HOST_CLIENT_APPLICATION_ID || await realpath(record.installPath) !== directory)
    throw invalid();
  if (record.envelope) {
    const descriptor = verifyEnvelope(record.envelope, trustedKeys);
    if (descriptor.artifactId !== path.basename(directory) || JSON.stringify(validateApplicationManifest(descriptor.manifest, { signed: true })) !== JSON.stringify(manifest)) throw invalid();
  }
  const entry = await realpath(path.join(directory, manifest.entrypoint));
  if (!entry.startsWith(`${directory}${path.sep}`)) throw invalid();

  // Give the child its own Chromium state before any app code can create a
  // window or take a single-instance lock. Apps may choose a narrower profile.
  let userData = path.join(root, ".runtime", manifest.applicationId);
  try { await access(userData); } catch {
    const legacyMarketData = path.join(path.dirname(root), "application-data", manifest.applicationId);
    try { await access(legacyMarketData); userData = legacyMarketData; } catch { /* First launch uses the shared application profile. */ }
  }
  process.env.WANX_HOST_APPLICATION_DATA = userData;
  await mkdir(userData, { recursive: true, mode: 0o700 });
  app.setName(manifest.name);
  app.setPath("userData", userData);
  app.setPath("sessionData", userData);
  const windows = new Set();
  const activate = () => {
    const window = [...windows].find(item => !item.isDestroyed());
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    app.focus({ steal: true });
  };
  receive(message => {
    if (message?.type === "wanx:application-activate" && message.launchId === environment.WANX_HOST_LAUNCH_ID) activate();
  });
  let reported = false;
  const report = type => {
    if (reported) return;
    reported = true;
    send({ type, launchId: environment.WANX_HOST_LAUNCH_ID });
  };
  app.on("browser-window-created", (_event, window) => {
    windows.add(window);
    window.once("closed", () => windows.delete(window));
    window.webContents.once("did-finish-load", () => report("wanx:application-ready"));
    window.webContents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
      if (mainFrame !== false && code !== -3) report("wanx:application-failed");
    });
  });
  app.once("before-quit", () => report("wanx:application-failed"));
  await load(entry);
}
