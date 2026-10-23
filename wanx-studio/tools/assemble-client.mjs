// Rebuild Builder resources from checked-in source. Generated assets stay ignored.
import { build } from 'esbuild';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const edition = process.argv[2];
if (!['personal', 'team'].includes(edition)) throw Error('EDITION_REQUIRED');
if (edition === 'personal') process.exit(0);
const client = path.resolve(root, '../wanx-team-client');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
for (const script of ['build', 'package']) {
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
}
await mkdir(path.join(client, 'studio'), { recursive: true });
await cp(path.join(root, 'dist/runtime'), path.join(client, 'applications/studio-runtime'), { recursive: true });
await cp(path.join(root, `release/wanx-studio-${version}`), path.join(client, 'studio/workbench'), { recursive: true });
// The packaged host must resolve everything inside its own ASAR, with no repo paths.
await build({ entryPoints: [path.join(root, 'integration/host-control.mjs')], bundle: true, platform: 'node', format: 'esm', outfile: path.join(client, 'applications/studio.mjs'), logLevel: 'silent' });
await build({ entryPoints: [path.join(root, 'integration/embedded-workspace.mjs')], bundle: true, platform: 'node', format: 'esm', outfile: path.join(client, 'studio/embedded-workspace.mjs'), logLevel: 'silent' });
await cp(path.join(root, 'integration/embedded-preload.cjs'), path.join(client, 'studio/embedded-preload.cjs'));
for (const [source, output, platform] of [
  ['service.mjs', 'shell/team-service.mjs', 'node'],
  ['data-service.mjs', 'shell/team-data-service.mjs', 'node'],
  ['wanx-mcp-bridge.mjs', 'shell/wanx-mcp-bridge.mjs', 'node'],
  ['data-view.js', 'local-ui/renderer/data-view.js', 'browser'],
]) {
  await build({ entryPoints: [path.join(root, 'integration/team-client', source)], bundle: true, platform, format: platform === 'browser' ? 'iife' : 'esm', outfile: path.join(client, output), logLevel: 'silent',
    ...(source === 'data-service.mjs' ? { banner: { js: 'import {createRequire as teamDataRequire} from "node:module";const require=teamDataRequire(import.meta.url);' } } : {}) });
}
