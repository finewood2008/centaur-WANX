import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const targets = {
  'darwin-arm64': 'arm64-apple-macos12.0',
  'darwin-x64': 'x86_64-apple-macos12.0',
};

if (process.platform !== 'darwin') {
  console.log('Skipping macOS box discovery helper on this platform.');
} else {
  const requested = process.argv.slice(2);
  const names = [...new Set(requested.length ? requested : [`darwin-${process.arch}`])];
  if (names.some((name) => !targets[name])) {
    throw new Error(`Unsupported target. Choose ${Object.keys(targets).join(', ')}`);
  }
  const source = path.join(root, 'native/discovery.swift');
  const plist = path.join(root, 'native/DiscoveryInfo.plist');
  const buildSource = readFileSync(fileURLToPath(import.meta.url));
  const sourceContent = readFileSync(source);
  const plistContent = readFileSync(plist);
  const directory = path.join(root, 'native/bin');
  mkdirSync(directory, { recursive: true });

  for (const name of names) {
    const output = path.join(directory, `wanx-discovery-${name}`);
    const stamp = `${output}.sha256`;
    const digest = createHash('sha256').update(buildSource).update(sourceContent)
      .update(plistContent).update(targets[name]).digest('hex');
    if (existsSync(output) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === digest) {
      console.log(`Box discovery helper is current: ${name}`);
      continue;
    }
    const cache = mkdtempSync(path.join(os.tmpdir(), 'wanx-discovery-'));
    const temporary = `${output}.${randomUUID()}.tmp`;
    try {
      console.log(`Building box discovery helper: ${name}`);
      execFileSync('xcrun', [
        'swiftc', '-O', '-module-cache-path', cache, '-target', targets[name], source,
        '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist',
        '-Xlinker', plist, '-o', temporary,
      ], { stdio: 'inherit' });
      renameSync(temporary, output);
      writeFileSync(stamp, `${digest}\n`);
    } finally {
      rmSync(temporary, { force: true });
      rmSync(cache, { recursive: true, force: true });
    }
  }
}
