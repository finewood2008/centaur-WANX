// Rebuild Builder resources from checked-in source. Generated assets stay ignored.
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const edition = process.argv[2];
if (!['personal', 'team'].includes(edition)) throw Error('EDITION_REQUIRED');
// Builder belongs to Studio. Mini keeps its original application/navigation surface.
if (edition === 'personal') process.exit(0);
const client = path.resolve(root, edition==='personal'?'../wanx-client':'../wanx-team-client');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
for (const script of ['build', 'package']) {
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
}
await mkdir(path.join(client, 'studio'), { recursive: true });
await cp(path.join(root, 'dist/runtime'), path.join(client, 'applications/studio-runtime'), { recursive: true });
await cp(path.join(root, `release/wanx-studio-${version}`), path.join(client, 'studio/workbench'), { recursive: true });
if(edition==='team'){
// Starlink is copied as a complete application directory. Materialize its
// vendored SDK and the locked WebSocket dependency before ASAR packaging.
const starlink = path.join(client, 'applications/starlink');
const sdkTarget = path.join(starlink, 'node_modules/@centaurai/wanx-host-sdk');
await rm(sdkTarget, { recursive: true, force: true });
await mkdir(path.dirname(sdkTarget), { recursive: true });
await cp(path.join(starlink, 'vendor/wanx-host-sdk'), sdkTarget, { recursive: true });
await cp(path.join(root, 'node_modules/ws'), path.join(starlink, 'node_modules/ws'), { recursive: true });
}
// The packaged host must resolve everything inside its own ASAR, with no repo paths.
await build({ entryPoints: [path.join(root, 'integration/host-control.mjs')], bundle: true, platform: 'node', format: 'esm', outfile: path.join(client, 'applications/studio.mjs'), logLevel: 'silent' });
await build({ entryPoints: [path.join(root, 'integration/embedded-workspace.mjs')], bundle: true, platform: 'node', format: 'esm', outfile: path.join(client, 'studio/embedded-workspace.mjs'), logLevel: 'silent' });
await cp(path.join(root, 'integration/embedded-preload.cjs'), path.join(client, 'studio/embedded-preload.cjs'));
for(const name of ['studio-home.js','studio-product.js','studio-intake.js','studio-input.js','studio-home.css','construction.js','construction.css'])await cp(path.join(root,'integration',name),path.join(client,'local-ui/renderer',name));
await mkdir(path.join(client,'local-ui/renderer/assets'),{recursive:true});
await cp(path.join(root,'ui/assets/wanx-builder.svg'),path.join(client,'local-ui/renderer/assets/wanx-builder.svg'));
if(edition==='team')await cp(path.join(root,'integration/team-client/view.js'),path.join(client,'local-ui/renderer/team-view.js'));
if(edition==='team')
for (const [source, output, platform] of [
  ['service.mjs', 'shell/team-service.mjs', 'node'],
  ['data-service.mjs', 'shell/team-data-service.mjs', 'node'],
  ['wanx-mcp-bridge.mjs', 'shell/wanx-mcp-bridge.mjs', 'node'],
  ['data-view.js', 'local-ui/renderer/data-view.js', 'browser'],
]) {
  await build({ entryPoints: [path.join(root, 'integration/team-client', source)], bundle: true, platform, format: platform === 'browser' ? 'iife' : 'esm', outfile: path.join(client, output), logLevel: 'silent',
    ...(source === 'data-service.mjs' ? { banner: { js: 'import {createRequire as teamDataRequire} from "node:module";const require=teamDataRequire(import.meta.url);' } } : {}) });
}
