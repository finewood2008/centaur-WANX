import { readFile, writeFile, copyFile, mkdtemp, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

// This is a migration for the retired local-development adapter, not a
// production startup setting. Refuse unfamiliar adapters instead of rewriting them.
const LEGACY_TAIL = ` let opening=false,opened=false,closed=false;
 const maybeOpen=()=>{
   const snapshot=client.snapshot();report.phase=snapshot.phase;report.accountAuthenticated=snapshot.account?.phase==='authenticated';report.boxConnected=Boolean(snapshot.connection?.deviceId);void save();
   if(closed||opening||opened||snapshot.phase!=='ready'||!report.accountAuthenticated||!report.boxConnected)return;
   opening=true;void manager.listInstalled().then(items=>items.some(item=>item.applicationId===manifest.applicationId)?manager.launch(manifest.applicationId):null).then(()=>{opened=true;report.ready=true;void save();},error=>{report.launchError=error.code||'SOURCE_START_FAILED';void save();}).finally(()=>{opening=false;});
 };
 const unsubscribe=client.subscribe(maybeOpen);
 maybeOpen();
 return {applicationId:manifest.applicationId,manager,listInstalled:manager.listInstalled,async open(){const value=await manager.launch(manifest.applicationId);opened=true;report.ready=true;await save();return value;},async close(){closed=true;unsubscribe();await manager.close();await writes;}};
}
`;
const MANUAL_TAIL = ` // Observe connection state only. Hosted apps launch through the user's Open action.
 const updateConnectionState=()=>{
   const snapshot=client.snapshot();report.phase=snapshot.phase;report.accountAuthenticated=snapshot.account?.phase==='authenticated';report.boxConnected=Boolean(snapshot.connection?.deviceId);void save();
 };
 const unsubscribe=client.subscribe(updateConnectionState);
 updateConnectionState();
 return {applicationId:manifest.applicationId,manager,listInstalled:manager.listInstalled,async close(){unsubscribe();await manager.close();await writes;}};
}
`;
const SECOND_INSTANCE = '      app.on("second-instance", () => { void sourceDevelopment.open().catch(() => {}); });';

export function removeZhijunAutoStart({ main, adapter }) {
  const nextMain = main.split("\n").filter(line => line !== SECOND_INSTANCE).join("\n");
  if (nextMain.includes("sourceDevelopment.open(")) throw new Error("UNSUPPORTED_SECOND_INSTANCE_HOOK");
  let nextAdapter = adapter;
  if (adapter.endsWith(LEGACY_TAIL)) {
    nextAdapter = adapter.slice(0, -LEGACY_TAIL.length) + MANUAL_TAIL;
  } else if (!adapter.endsWith(MANUAL_TAIL)) {
    throw new Error("UNSUPPORTED_SOURCE_DEVELOPMENT_ADAPTER");
  }
  return { main: nextMain, adapter: nextAdapter, changed: nextMain !== main || nextAdapter !== adapter };
}

export async function migrateClient(clientDirectory, { apply = false } = {}) {
  const directory = path.resolve(clientDirectory);
  const mainPath = path.join(directory, "shell/main.mjs");
  const adapterPath = path.join(directory, "zhijun-source-dev.mjs");
  const main = await readFile(mainPath, "utf8");
  let adapter;
  try { adapter = await readFile(adapterPath, "utf8"); }
  catch (error) {
    if (error.code !== "ENOENT" || main.includes("sourceDevelopment.open(")) throw error;
    return { changed: false, applied: false, reason: "NO_DEVELOPMENT_ADAPTER" };
  }
  const next = removeZhijunAutoStart({ main, adapter });
  if (!next.changed || !apply) return { changed: next.changed, applied: false };

  const backupDirectory = await mkdtemp(path.join(directory, ".manual-launch-backup-"));
  await mkdir(path.join(backupDirectory, "shell"));
  const files = [[mainPath, "shell/main.mjs", next.main], [adapterPath, "zhijun-source-dev.mjs", next.adapter]];
  for (const [file, relative] of files) await copyFile(file, path.join(backupDirectory, relative));
  try {
    for (const [file, relative, content] of files) {
      const temporary = path.join(backupDirectory, `${relative}.new`);
      await writeFile(temporary, content, { flag: "wx" });
      await rename(temporary, file);
    }
  } catch (error) {
    for (const [file, relative] of files) {
      await copyFile(path.join(backupDirectory, relative), file);
      await rm(path.join(backupDirectory, `${relative}.new`), { force: true });
    }
    throw error;
  }
  return { changed: true, applied: true, backupDirectory };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { "client-dir": { type: "string" }, apply: { type: "boolean", default: false } } });
    if (!values["client-dir"]) throw new Error("Usage: node tools/disable-zhijun-autostart.mjs --client-dir <wanx-client> [--apply]");
    console.log(JSON.stringify(await migrateClient(values["client-dir"], { apply: values.apply })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
