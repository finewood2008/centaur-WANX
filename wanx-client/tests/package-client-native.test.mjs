import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import afterPack, { probeNativeEngine, readPackagedNativeBinaries, verifyPackagedNativeBinaries, verifyClipboardNative } from "../tools/package-client-native.mjs";

async function fixture(t, platform = process.platform === "win32" ? "win32" : "darwin", arch = "arm64") {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-native-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDirectory = path.join(root, "source", "native", "bin");
  const resourcesPath = path.join(root, "staged", "resources");
  const names = platform === "darwin"
    ? [`wanx-netbird-darwin-${arch}`, `wanx-discovery-darwin-${arch}`]
    : [`wanx-netbird-win32-${arch}.exe`, "wanx-discovery-win32-x64.exe"];
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(path.join(resourcesPath, "network"), { recursive: true });
  for (const name of names) {
    const source = path.join(sourceDirectory, name);
    await writeFile(source, `verified ${name}`, { mode: 0o755 });
    await copyFile(source, path.join(resourcesPath, "network", name));
  }
  return { root, sourceDirectory, resourcesPath, names, platform, arch };
}

test("package verification records the exact shipped helper hashes for both platforms and architectures", async t => {
  // Windows cannot represent the POSIX execute-bit contract of macOS files.
  const platforms = process.platform === "win32" ? ["win32"] : ["darwin", "win32"];
  for (const platform of platforms) for (const arch of ["arm64", "x64"]) {
    const input = await fixture(t, platform, arch);
    const result = await verifyPackagedNativeBinaries(input);
    for (const [index, kind] of ["engine", "discovery"].entries()) {
      const expected = await readFile(path.join(input.sourceDirectory, input.names[index]));
      assert.equal(result[kind].file, input.names[index]);
      assert.equal(result[kind].bytes, expected.length);
      assert.equal(result[kind].sha256, createHash("sha256").update(expected).digest("hex"));
    }
  }
});

test("an omitted or misplaced helper fails packaging even when a source-layout copy exists", async t => {
  for (const index of [0, 1]) {
    const input = await fixture(t);
    const file = path.join(input.resourcesPath, "network", input.names[index]);
    const misplaced = path.join(input.resourcesPath, "app", "native", "bin", input.names[index]);
    await mkdir(path.dirname(misplaced), { recursive: true });
    await copyFile(file, misplaced);
    await rm(file);
    await assert.rejects(verifyPackagedNativeBinaries(input), /CLIENT_NATIVE_BINARY_MISSING/);
  }
});

test('Mac clipboard helper must be executable, present and match the compiled source', {skip:process.platform==='win32'}, async t=>{
 const input=await fixture(t,'darwin','arm64'),name='wanx-clipboard-darwin-arm64';
 await assert.rejects(verifyClipboardNative(input),/CLIENT_CLIPBOARD_HELPER_MISSING/);
 const source=path.join(input.sourceDirectory,name),target=path.join(input.resourcesPath,'network',name);
 await writeFile(source,'synthetic helper',{mode:0o755});await copyFile(source,target);
 await verifyClipboardNative(input);
 await writeFile(target,'stale');await assert.rejects(verifyClipboardNative(input),/CLIENT_CLIPBOARD_HELPER_MISMATCH/);
});

test("stale or truncated native files cannot pass with a successful source build", async t => {
  const input = await fixture(t);
  const file = path.join(input.resourcesPath, "network", input.names[0]);
  await writeFile(file, "stale engine");
  await assert.rejects(verifyPackagedNativeBinaries(input), /CLIENT_NATIVE_BINARY_MISMATCH/);
  await writeFile(file, "");
  await assert.rejects(verifyPackagedNativeBinaries(input), /CLIENT_NATIVE_BINARY_INVALID/);
});

test("final artifact records use signed bytes while the pre-sign gate still rejects a source mismatch", async t => {
  const input = await fixture(t);
  const before = await verifyPackagedNativeBinaries(input);
  const file = path.join(input.resourcesPath, "network", input.names[0]);
  const signed = Buffer.from("fixture engine with a signing trailer");
  await writeFile(file, signed);
  const final = await readPackagedNativeBinaries(input);
  assert.notEqual(final.engine.sha256, before.engine.sha256);
  assert.equal(final.engine.sha256, createHash("sha256").update(signed).digest("hex"));
  await assert.rejects(verifyPackagedNativeBinaries(input), /CLIENT_NATIVE_BINARY_MISMATCH/);
});

test("Unix executable permissions and regular-file packaging are required", { skip: process.platform === "win32" }, async t => {
  const input = await fixture(t);
  const file = path.join(input.resourcesPath, "network", input.names[0]);
  await chmod(file, 0o644);
  await assert.rejects(verifyPackagedNativeBinaries(input), /CLIENT_NATIVE_BINARY_INVALID/);
  await chmod(file, 0o641);
  await assert.rejects(verifyPackagedNativeBinaries(input), /CLIENT_NATIVE_BINARY_INVALID/);
  await rm(file);
  await symlink(path.join(input.sourceDirectory, input.names[0]), file);
  await assert.rejects(verifyPackagedNativeBinaries(input), /CLIENT_NATIVE_BINARY_INVALID/);
});

test("the default afterPack hook fails before distribution when bundled native files are missing", async t => {
  const input = await fixture(t, "win32", "arm64");
  await rm(path.join(input.resourcesPath, "network", input.names[1]));
  await assert.rejects(afterPack({ electronPlatformName: "win32", arch: 3,
    appOutDir: path.dirname(input.resourcesPath), packager: { projectDir: path.join(input.root, "source") } }),
  /CLIENT_NATIVE_BINARY_MISSING/);
});

test("native engine smoke checks status and stops without supplying account or enrollment data", { skip: process.platform === "win32" }, async t => {
  const input = await fixture(t);
  const engine = path.join(input.root, "status-only-engine");
  for (const phase of ["ready", "disabled"]) {
    await writeFile(engine, `#!/usr/bin/env node\nprocess.stdin.setEncoding('utf8');let text='';process.stdin.on('data', chunk=>{text+=chunk;let i;while((i=text.indexOf('\\n'))>=0){const request=JSON.parse(text.slice(0,i));text=text.slice(i+1);if(request.method==='stop')process.exit(0);if(request.method!=='status'||Object.keys(request.params).length)process.exit(2);process.stdout.write(JSON.stringify({id:request.id,result:{phase:'${phase}',peers:[]}})+'\\n');}});\n`, { mode: 0o755 });
    if (phase === "disabled") await probeNativeEngine(engine);
    else await assert.rejects(probeNativeEngine(engine), /CLIENT_NATIVE_ENGINE_SMOKE_FAILED/);
  }
});

test("all public client build configurations use the native verification hook", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.build.afterPack, "tools/package-client-native.mjs");
  const mac = await readFile(new URL("../tools/package-client.mjs", import.meta.url), "utf8");
  assert.match(mac, /afterPack: path.join\(root, "tools\/package-client-native.mjs"\)/);
});
