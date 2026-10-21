import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { patchWifiScan } from './provisioning-wifi-patch.mjs';

// Local compatibility patch until the upstream SDK accepts public box names.
// Keep the pinned upstream archives: rebuilding never uses node_modules.
const root = fileURLToPath(new URL('../', import.meta.url));
const versions = { contracts: '2.0.1-wanx.2', core: '2.0.1-wanx.3' };
const baselines = {
  contracts: '144d7763fda3f761f26e4b5b35016d1dc00fd33f9320830b9fd0c04fa9e9fa26',
  core: 'aef4c38afc64ec38cb1e0a1a13c3bd88ff03fe748061c39b4fa4be9f5ce68c21',
};
const check = process.argv.includes('--check');
if (process.argv.slice(2).some((arg) => arg !== '--check')) throw Error('Only --check is supported');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const runNpm = (args, options) => execFileSync(process.platform === 'win32' ? process.execPath : 'npm',
  process.platform === 'win32' ? [npmCli, ...args] : args, options);
function archiveEqual(left, right) {
  const a = readFileSync(left), b = readFileSync(right);
  return a.equals(b) || gunzipSync(a).equals(gunzipSync(b));
}
function replaceOnce(source, from, to) {
  if (source.split(from).length !== 2) throw Error(`SDK patch anchor is not unique: ${from}`);
  return source.replace(from, to);
}
const temporary = mkdtempSync(path.join(os.tmpdir(), 'wanx-provisioning-sdk-'));
try {
  for (const [kind, expected] of Object.entries(baselines)) {
    const version = versions[kind];
    const archive = path.join(root, 'vendor', `nexusaos-local-provisioning-${kind}-2.0.0.tgz`);
    if (sha256(readFileSync(archive)) !== expected) throw Error(`SDK baseline hash mismatch: ${kind}`);
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    const directory = path.join(temporary, kind);
    mkdirSync(directory);
    for (const entry of entries) {
      if (!/^package\/(?:package\.json|README\.md|dist\/[a-z]+(?:\.d)?\.js|dist\/[a-z]+\.d\.ts)$/.test(entry)) {
        throw Error(`Unexpected SDK archive member: ${entry}`);
      }
      const destination = path.join(directory, entry.slice('package/'.length));
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, execFileSync('tar', ['-xOzf', archive, entry]), { mode: 0o644 });
    }
    const manifestPath = path.join(directory, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.name !== `@nexusaos/local-provisioning-${kind}` || manifest.version !== '2.0.0') {
      throw Error(`Unexpected SDK package identity: ${kind}`);
    }
    manifest.version = version;
    if (kind === 'core') manifest.dependencies['@nexusaos/local-provisioning-contracts'] = versions.contracts;
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    if (kind === 'contracts') {
      const target = path.join(directory, 'dist/index.d.ts');
      writeFileSync(target, replaceOnce(readFileSync(target, 'utf8'),
        'display_name: "CentaurAI Box";',
        '/** Public display hint: 1–64 UTF-16 units; no control characters or unpaired surrogates. */\n    display_name: string;'));
    } else {
      const target = path.join(directory, 'dist/index.js');
      writeFileSync(target, replaceOnce(readFileSync(target, 'utf8'),
        'value.display_name !== "CentaurAI Box" ||',
        'typeof value.display_name !== "string" ||\n' +
        '        value.display_name.trim().length === 0 ||\n' +
        '        value.display_name.length > 64 ||\n' +
        '        /[\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]/u.test(value.display_name) ||'));
    }
    patchWifiScan(directory, kind);
    if (kind === 'core') {
      const target = path.join(directory, 'dist/coordinator.js');
      writeFileSync(target, replaceOnce(readFileSync(target, 'utf8'),
        '    if (error.code === "hello_context_expired")',
        '    if (error.code === "OWNER_AUTHORIZATION_SYNC_PENDING")\n' +
        '        return new ClaimCoordinatorFailure("OWNER_AUTHORIZATION_SYNC_PENDING", true);\n' +
        '    if (error.code === "hello_context_expired")'));
    }
    // npm pack uses a fixed archive timestamp; scripts are intentionally disabled
    // because these upstream archives contain the published dist files only.
    const packed = JSON.parse(runNpm(
      ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', temporary],
      { cwd: directory, encoding: 'utf8' }));
    const expectedFilename = `nexusaos-local-provisioning-${kind}-${version}.tgz`;
    if (packed.length !== 1 || packed[0].filename !== expectedFilename) throw Error('Unexpected packed SDK filename');
    const generated = path.join(temporary, expectedFilename);
    const destination = path.join(root, 'vendor', expectedFilename);
    if (check) {
      if (!archiveEqual(destination, generated)) throw Error(`SDK patch is not reproducible: ${kind}`);
    } else renameSync(generated, destination);
    console.log(`${check ? 'Verified' : 'Built'} ${expectedFilename} ${sha256(readFileSync(destination))}`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
