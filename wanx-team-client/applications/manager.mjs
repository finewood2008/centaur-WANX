import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStudioControl, createStudioEntry, installBundledWorkbench, STUDIO_ID } from "./studio.mjs";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { verifyEnvelope } from "./descriptor.mjs";
import { createApplicationSession } from "../app-host/session.mjs";
import { createApplicationInstaller } from "./installer.mjs";
import { createApplicationLauncher } from "./launcher.mjs";
import { assertApplicationCompatibility } from "./compatibility.mjs";
import { createDefaultApplicationStore } from "./delivery.mjs";
import { inspectZhijunData } from "./zhijun-data.mjs";

export async function createApplicationManager({
  applicationRoot,
  applicationId,
  context,
  request,
  stream,
  createConnection,
  spawn,
  electronPath,
  runtimeArgs,
  launcherArgs,
  trustedKeys = {},
  getCompatibilityContext,
  prepareApplication,
  authorizeRelease,
  onStudioInstalled,
  chooseStudioExport,
  returnToStudioClient,
  openStudioWorkspace,
  placeStudioWorkspace,
} = {}) {
  applicationRoot = path.resolve(applicationRoot);
  const defaultApplicationDeliveryStore = createDefaultApplicationStore(path.join(applicationRoot, ".delivery"));
  const dataAccessRoot = path.join(applicationRoot, ".data-access");
  const dataUnknown = () => Object.assign(new Error("APPLICATION_DATA_COMPATIBILITY_UNKNOWN"), { code: "APPLICATION_DATA_COMPATIBILITY_UNKNOWN" });
  async function dataAccessDirectory(create = false) {
    try {
      if (create) await mkdir(dataAccessRoot, { mode: 0o700 });
    } catch (error) { if (error.code !== "EEXIST") throw dataUnknown(); }
    try {
      const info = await lstat(dataAccessRoot);
      if (!info.isDirectory() || info.isSymbolicLink() ||
          await realpath(dataAccessRoot) !== path.join(await realpath(applicationRoot), ".data-access")) throw dataUnknown();
      return dataAccessRoot;
    } catch (error) { if (error.code === "ENOENT" && !create) return null; throw dataUnknown(); }
  }
  async function readDataAccess(id) {
    if (!await dataAccessDirectory()) return null;
    const filename = path.join(dataAccessRoot, `${id}.json`);
    let info;
    try { info = await lstat(filename); }
    catch (error) { if (error.code === "ENOENT") return null; throw dataUnknown(); }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096) throw dataUnknown();
    let handle;
    try {
      handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > 4096) throw dataUnknown();
      const value = JSON.parse(await handle.readFile("utf8"));
      if (value?.schemaVersion !== 1 || value.applicationId !== id ||
          Object.keys(value).sort().join() !== "applicationId,schemaVersion,writer" ||
          !value.writer || Object.keys(value.writer).sort().join() !== "artifactId,descriptorDigest" ||
          typeof value.writer.artifactId !== "string" || !/^[a-f0-9-]{36}$/.test(value.writer.artifactId) ||
          typeof value.writer.descriptorDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.writer.descriptorDigest)) throw dataUnknown();
      if (!await dataAccessDirectory()) throw dataUnknown();
      return value.writer;
    } catch { throw dataUnknown(); }
    finally { await handle?.close(); }
  }
  const writerFor = descriptor => descriptor?.schemaVersion >= 2 ? {
    artifactId: descriptor.artifactId,
    descriptorDigest: createHash("sha256").update(JSON.stringify(descriptor)).digest("hex"),
  } : null;
  const sameWriter = (left, right) => Boolean(left && right && left.artifactId === right.artifactId && left.descriptorDigest === right.descriptorDigest);
  async function writeDataAccess(id, writer) {
    await dataAccessDirectory(true);
    // Reject corrupted or redirected state even if schema evidence would allow
    // a new writer. An invalid Host record is never treated as a fresh profile.
    await readDataAccess(id);
    const temporary = path.join(dataAccessRoot, `.${id}-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(JSON.stringify({ schemaVersion: 1, applicationId: id, writer }));
        await handle.sync();
      } finally { await handle.close(); }
      await dataAccessDirectory();
      await rename(temporary, path.join(dataAccessRoot, `${id}.json`));
      if (process.platform !== "win32") {
        const directory = await open(dataAccessRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch { throw dataUnknown(); }
    finally { await rm(temporary, { force: true }); }
  }
  const compatibilityContext = async (input, access) => {
    const id = input.manifest.applicationId;
    const writer = access === undefined ? await readDataAccess(id) : access;
    let localDataPresent = Boolean(writer);
    const profileDirectories = [path.join(applicationRoot, ".runtime", id), path.join(applicationRoot, "..", "application-data", id)];
    for (const directory of profileDirectories) {
      try { localDataPresent ||= (await readdir(directory)).length > 0; }
      catch (error) {
        if (error.code !== "ENOENT") throw dataUnknown();
      }
    }
    // Only the audited shared Zhijun layout has a local schema reader. Other
    // applications retain the provider/continuity rules. Inspect both paths so
    // retained legacy data cannot disappear from the compatibility decision.
    const local = await inspectZhijunData({ manifest: input.descriptor?.manifest, profileDirectories });
    if (local?.status === "unknown") throw dataUnknown();
    if (local) localDataPresent = local.localDataPresent;
    // Never infer the actual schema from writeVersion. Refresh authenticated
    // provider evidence after all disk reads and reject conflicting evidence.
    const supplied = await getCompatibilityContext?.(input) || {};
    if (local?.localDataSchemaVersion && supplied.localDataSchemaVersion != null &&
        local.localDataSchemaVersion !== supplied.localDataSchemaVersion) throw dataUnknown();
    return { ...supplied,
      ...(local?.localDataSchemaVersion ? { localDataSchemaVersion: local.localDataSchemaVersion } : {}),
      localDataPresent: localDataPresent || supplied.localDataPresent === true };
  };
  const installer = createApplicationInstaller({
    rootDir: applicationRoot, trustedKeys, getCompatibilityContext: compatibilityContext, prepareApplication, authorizeRelease,
    hasTrustedDataContinuity: async descriptor => sameWriter(await readDataAccess(descriptor.applicationId), writerFor(descriptor)),
  });
  await installer.recover();
  const mutations = new Map();
  const dismissedDefaults = new Set();
  function assertOpen() {
    if (closed) throw Object.assign(new Error("APPLICATIONS_CLOSED"), { code: "APPLICATIONS_CLOSED" });
    if (maintenance) throw Object.assign(new Error("UPDATE_IN_PROGRESS"), { code: "UPDATE_IN_PROGRESS" });
  }
  async function track(operation) {
    installing.add(operation);
    try { return await operation; } finally { installing.delete(operation); }
  }
  function mutate(id, operation, assertSession = () => {}) {
    assertOpen();
    if (mutations.has(id)) return Promise.reject(Object.assign(new Error("MARKET_OPERATION_BUSY"), { code: "MARKET_OPERATION_BUSY" }));
    const check = () => { controller.signal.throwIfAborted(); assertSession(); };
    const pending = Promise.resolve().then(async () => {
      check();
      if (operation === installer.uninstall) dismissedDefaults.add(id);
      if (operation === installer.rollback) await installer.assertRollbackCompatible(id);
      check();
      await launcher.stop(id);
      check();
      // Preserve explicit removal even if the process exits during uninstall.
      // Default delivery must not reinstall an application the user removed.
      if (operation === installer.uninstall) await defaultApplicationDeliveryStore.dismiss(id, check);
      check();
      return operation(id, check);
    }).finally(() => mutations.delete(id));
    mutations.set(id, pending);
    return track(pending);
  }
  const installing = new Set(), controller = new AbortController();
  let closed = false, closing, maintenance = false;
  let studioControl, studioBootstrap, studioEntry;
  const launcher = createApplicationLauncher({
    resolveRecord: async input => {
      const id=typeof input === "string" ? input : input.applicationId;
      let record = await installer.resolveCurrent(id);
      if (record.protocolVersion < 2) return {...record,launchContext:typeof input === "object" ? input.launchContext : undefined};
      // Derive identity from the envelope again, not the mutable descriptor
      // copy in the local install record.
      const descriptor = record.envelope ? verifyEnvelope(record.envelope, trustedKeys) : undefined;
      const controlled = record.releaseAccess === "account";
      if (controlled) {
        if (!descriptor || !authorizeRelease) throw Object.assign(new Error("MARKET_RELEASE_ACCESS_REQUIRED"), { code: "MARKET_RELEASE_ACCESS_REQUIRED" });
        const permit = await authorizeRelease(descriptor);
        if (!permit) throw Object.assign(new Error("MARKET_RELEASE_ACCESS_REQUIRED"), { code: "MARKET_RELEASE_ACCESS_REQUIRED" });
        permit.assertLive();
      }
      const writer = writerFor(descriptor), previousWriter = await readDataAccess(id);
      if (record.protocolVersion === 3) {
        // Reject incompatible local data/client requirements before preparing
        // remote resources. Launch repeats these checks after preparation.
        await assertApplicationCompatibility(record, {
          getCompatibilityContext: input => compatibilityContext(input, previousWriter), descriptor, phase: "import",
          trustedDataContinuity: sameWriter(previousWriter, writer),
        });
        // A binding is scoped to an account, device and ownership epoch. Keep
        // the legacy launch path for pre-candidate installs; new selections
        // revalidate/rebind the same signed artifact before opening on a box.
        if (record.bindingSetId) {
          const prepared = await installer.prepareCurrent(id, { signal: controller.signal });
          if (prepared.artifactId !== record.artifactId) throw Object.assign(new Error("UPDATE_SESSION_CHANGED"), { code: "UPDATE_SESSION_CHANGED" });
          if (prepared.resourcePreparation?.status !== "ready") {
            const code = prepared.resourcePreparation?.code || "APPLICATION_RESOURCES_NOT_READY";
            throw Object.assign(new Error(code), { code });
          }
          record = prepared;
        }
      }
      let preparedConnection;
      await assertApplicationCompatibility(record, {
        getCompatibilityContext: async input => {
          const supplied = await compatibilityContext(input, previousWriter);
          if (record.protocolVersion === 3) preparedConnection = supplied.applicationConnection;
          return supplied;
        }, descriptor, phase: "launch",
        trustedDataContinuity: sameWriter(previousWriter, writer),
      });
      // Commit before any child can access the profile. If startup is canceled,
      // retain this possible-writer evidence rather than assuming nothing wrote.
      if (writer && !sameWriter(previousWriter, writer)) await writeDataAccess(id, writer);
      if (record.protocolVersion === 3 && !preparedConnection) throw Object.assign(new Error("APPLICATION_RESOURCES_NOT_READY"), { code: "APPLICATION_RESOURCES_NOT_READY" });
      return { ...record, launchContext:typeof input === "object" ? input.launchContext : undefined, ...(preparedConnection ? { preparedConnection } : {}),
        ...(controlled ? { authorizeRelease: options => authorizeRelease(descriptor, options) } : {}) };
    },
    onStarted: record => installer.prune(record.applicationId, record.version),
    host: {
      createSession(record, { signal }) {
        return createApplicationSession({
          hostApplicationId: applicationId,
          applicationId: record.applicationId,
          installPath: record.installPath,
          studioControl: record.applicationId === STUDIO_ID ? studioControl : undefined,
          createConnection: async () => (record.launchContext ? await createConnection?.(record.applicationId,{launchContext:record.launchContext}) : record.preparedConnection || await createConnection?.(record.applicationId)) || { context, request, openStream: stream },
          authorizeRelease: record.authorizeRelease,
          signal,
        });
      },
    },
    spawn,
    electronPath,
    runtimeArgs,
    launcherArgs,
  });
  const studioApi = Object.freeze({
    async install(input) {
      assertOpen();
      if (mutations.size) throw Object.assign(new Error("MARKET_OPERATION_BUSY"), { code: "MARKET_OPERATION_BUSY" });
      return track(installer.install(input, { signal: controller.signal }));
    },
    async installVerifiedPackage(input) {
      assertOpen();
      const descriptor = verifyEnvelope(input.envelope, trustedKeys);
      if (mutations.has(descriptor.applicationId)) throw Object.assign(new Error("MARKET_OPERATION_BUSY"), { code: "MARKET_OPERATION_BUSY" });
      if (input.onlyIfMissing) {
        const id = descriptor.applicationId, originalCheck = input.assertSession;
        if (await defaultApplicationDeliveryStore.isDismissed(id)) dismissedDefaults.add(id);
        const assertSession = () => {
          assertOpen();
          originalCheck?.();
          if (dismissedDefaults.has(id)) throw Object.assign(new Error("DEFAULT_APPLICATION_USER_REMOVED"), { code: "DEFAULT_APPLICATION_USER_REMOVED" });
          if (mutations.has(id)) throw Object.assign(new Error("MARKET_OPERATION_BUSY"), { code: "MARKET_OPERATION_BUSY" });
        };
        assertSession();
        input = { ...input, assertSession };
      }
      // Preparing an update never interrupts the running version; launch owns switching.
      return track(installer.installVerifiedPackage(input, { signal: controller.signal }));
    },
    uninstall: (id, check) => mutate(id, installer.uninstall, check),
    rollback: (id, check) => mutate(id, installer.rollback, check),
    async selectCurrent(id, version) {
      assertOpen();
      return track(installer.selectCurrent(id, version, { signal: controller.signal }));
    },
    studio: Object.freeze({
      previewOpen:input=>studioEntry.previewOpen(input),previewInvoke:input=>studioEntry.previewInvoke(input),previewClose:input=>studioEntry.previewClose(input),runtimeModel:input=>studioEntry.runtimeModel(input),runtimeModelSave:input=>studioEntry.runtimeModelSave(input),
      launchSuggest:input=>studioEntry.launchSuggest(input), launchSources:input=>studioEntry.launchSources(input), launchConfigure:input=>studioEntry.launchConfigure(input), launchStart:input=>studioEntry.launchStart(input), placement: input=>studioEntry.placement(input), enginesList:()=>studioEntry.enginesList(), enginesCheck:input=>studioEntry.enginesCheck(input), enginesDefault:input=>studioEntry.enginesDefault(input), intakeOpen:input=>studioEntry.intakeOpen(input), intakeSend:input=>studioEntry.intakeSend(input), intakeState:input=>studioEntry.intakeState(input), intakeEvents:input=>studioEntry.intakeEvents(input), contextSources:input=>studioEntry.contextSources(input), contextSelect:input=>studioEntry.contextSelect(input), capabilitiesList:()=>studioEntry.capabilitiesList(), capabilitiesState:input=>studioEntry.capabilitiesState(input), capabilitiesCheck:input=>studioEntry.capabilitiesCheck(input), capabilitiesDecide:input=>studioEntry.capabilitiesDecide(input), intakeHandoff:input=>studioEntry.intakeHandoff(input), workspace:input=>studioEntry.workspace(input), metadata:input=>studioEntry.metadata(input), export:input=>studioEntry.export(input),
      overview: () => studioEntry.overview(), create: input => studioEntry.create(input), open: input => studioEntry.open(input),
    }),
    listInstalled: installer.list,
    defaultApplicationDeliveryStore,
    async prepareInstalledApplication(id, assertSession = () => {}) {
      assertOpen();
      return track((async () => {
        const check = () => { controller.signal.throwIfAborted(); assertSession(); };
        check();
        const current = await installer.resolveCurrent(id);
        check();
        const descriptor = current.envelope ? verifyEnvelope(current.envelope, trustedKeys) : undefined;
        const continuity = sameWriter(await readDataAccess(id), writerFor(descriptor));
        check();
        let permit;
        // Resource-free account releases still require current authorization.
        // prepareCurrent can return early when there are no resource bindings.
        if (current.releaseAccess === "account") {
          if (!descriptor || !authorizeRelease) throw Object.assign(new Error("MARKET_RELEASE_ACCESS_REQUIRED"), { code: "MARKET_RELEASE_ACCESS_REQUIRED" });
          permit = await authorizeRelease(descriptor, { signal: controller.signal });
          check();
          if (!permit) throw Object.assign(new Error("MARKET_RELEASE_ACCESS_REQUIRED"), { code: "MARKET_RELEASE_ACCESS_REQUIRED" });
          permit.assertLive();
        }
        await assertApplicationCompatibility(current, { getCompatibilityContext: compatibilityContext, descriptor,
          phase: "import", trustedDataContinuity: continuity });
        check();
        const result = await installer.prepareCurrent(id, { assertSession, signal: controller.signal });
        check();
        if (!result.resourcePreparation || result.resourcePreparation.status === "ready") {
          await assertApplicationCompatibility(result, { getCompatibilityContext: compatibilityContext, descriptor,
            phase: "launch", trustedDataContinuity: continuity });
        }
        check();
        permit?.assertLive();
        return result;
      })());
    },
    async launch(input) {
      const id=typeof input === "string" ? input : input.applicationId;
      assertOpen();
      if (mutations.has(id)) return Promise.reject(Object.assign(new Error("MARKET_OPERATION_BUSY"), { code: "MARKET_OPERATION_BUSY" }));
      if (id === STUDIO_ID) {
        // Opening the independent app from the launcher must enforce the same
        // server-side administrator gate as opening a project from the client.
        const assertStudioSession = await studioEntry.authorize();
        if (!studioBootstrap) studioBootstrap = (async () => {
          const sourceDir = fileURLToPath(new URL("../studio/workbench", import.meta.url));
          await installBundledWorkbench(installer, sourceDir, { signal: controller.signal });
        })().finally(() => { studioBootstrap = null; });
        await studioBootstrap; assertOpen();
        assertStudioSession();
      }
      return track(launcher.launch(input));
    },
    isBusy: () => maintenance || installing.size > 0 || mutations.size > 0,
    beginMaintenance() {
      assertOpen();
      if (installing.size || mutations.size) throw Object.assign(new Error("UPDATE_IN_PROGRESS"), { code: "UPDATE_IN_PROGRESS" });
      maintenance = true;
      let released = false;
      return () => { if (!released) { released = true; maintenance = false; } };
    },
    activate: launcher.activate,
    stop: launcher.stop,
    close() {
      closed = true;
      controller.abort();
      return closing ||= (async () => {
        const results = await Promise.allSettled([launcher.close(), ...installing]);
        if (results[0].status === "rejected") throw results[0].reason;
      })().catch(error => { closing = null; throw error; });
    },
    installRoot: path.resolve(applicationRoot),
  });
  studioEntry = createStudioEntry({ createConnection, applications: studioApi, assets:fileURLToPath(new URL("./studio-runtime",import.meta.url)),chooseExport:chooseStudioExport,openWorkspace:openStudioWorkspace,workspacePlacement:placeStudioWorkspace });
  studioControl = createStudioControl({ applications: studioApi, assets: fileURLToPath(new URL("./studio-runtime", import.meta.url)), onChanged: onStudioInstalled, returnToClient:returnToStudioClient, navigation: connection => studioEntry.navigation(connection) });
  return studioApi;
}
