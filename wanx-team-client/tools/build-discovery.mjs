import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const targets = {
  'darwin-arm64': 'arm64-apple-macos12.0',
  'darwin-x64': 'x86_64-apple-macos12.0',
};

if (process.platform === 'win32') {
  const requested = process.argv.slice(2);
  if (requested.length && requested.some((name) => name !== 'win32-x64')) throw new Error('Unsupported Windows discovery target: win32-x64 only');
  const windows = process.env.SystemRoot || 'C:\\Windows';
  const sdk = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits/10/UnionMetadata');
  const metadata = readdirSync(sdk, { withFileTypes: true }).filter((item) => item.isDirectory() && /^\d+(?:\.\d+){3}$/.test(item.name))
    .map((item) => item.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((version) => path.join(sdk, version, 'Windows.winmd')).find(existsSync);
  const framework = path.join(windows, 'Microsoft.NET/Framework64/v4.0.30319');
  const gac = path.join(windows, 'Microsoft.NET/assembly/GAC_MSIL');
  const references = [metadata, path.join(framework, 'System.Runtime.WindowsRuntime.dll'),
    path.join(gac, 'System.Runtime/v4.0_4.0.0.0__b03f5f7f11d50a3a/System.Runtime.dll'),
    path.join(gac, 'System.Runtime.InteropServices.WindowsRuntime/v4.0_4.0.0.0__b03f5f7f11d50a3a/System.Runtime.InteropServices.WindowsRuntime.dll')];
  if (!metadata || references.some((file) => !existsSync(file)) || !existsSync(path.join(framework, 'csc.exe')))
    throw new Error('Windows SDK metadata and .NET Framework C# compiler are required for box discovery');
  const source = path.join(root, 'native/discovery-windows.cs');
  const directory = path.join(root, 'native/bin');
  const output = path.join(directory, 'wanx-discovery-win32-x64.exe');
  const stamp = `${output}.sha256`;
  const digest = createHash('sha256').update(readFileSync(source)).update(readFileSync(fileURLToPath(import.meta.url)))
    .update(readFileSync(metadata)).digest('hex');
  mkdirSync(directory, { recursive: true });
  if (!existsSync(output) || !existsSync(stamp) || readFileSync(stamp, 'utf8').trim() !== digest) {
    const temporary = `${output}.${randomUUID()}.tmp.exe`;
    try {
      execFileSync(path.join(framework, 'csc.exe'), ['/nologo', '/target:exe', '/platform:x64', `/out:${temporary}`,
        ...references.map((file) => `/r:${file}`), '/r:System.Web.Extensions.dll', source], { stdio: 'inherit' });
      renameSync(temporary, output);
      writeFileSync(stamp, `${digest}\n`);
    } finally { rmSync(temporary, { force: true }); }
  }
  console.log('Windows box discovery helper is current: win32-x64');
} else if (process.platform !== 'darwin') {
  console.log('Skipping box discovery helper on this platform.');
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
