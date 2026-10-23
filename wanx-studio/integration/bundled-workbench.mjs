import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Electron can read ASAR files, but fs.cp uses native opendir and cannot copy
// ASAR directories. Materialize only this trusted bundle before normal install.
export async function installBundledWorkbench(installer, sourceDir, { signal } = {}) {
  const bundled = JSON.parse(await readFile(path.join(sourceDir, 'application.manifest.json'), 'utf8'));
  const installed = (await installer.list()).find(record => record.applicationId === bundled.applicationId);
  if (installed?.version === bundled.version) return;
  const staging = await mkdtemp(path.join(tmpdir(), 'wanx-studio-bundle-'));
  async function copyDirectory(source, target) {
    signal?.throwIfAborted();
    await mkdir(target);
    for (const entry of await readdir(source, { withFileTypes: true })) {
      signal?.throwIfAborted();
      const from = path.join(source, entry.name), to = path.join(target, entry.name);
      if (entry.isDirectory()) await copyDirectory(from, to);
      else if (entry.isFile()) await writeFile(to, await readFile(from), { flag: 'wx' });
      else throw new Error('STUDIO_BUNDLE_FILE_INVALID');
    }
  }
  try {
    const directory = path.join(staging, 'workbench');
    await copyDirectory(sourceDir, directory);
    signal?.throwIfAborted();
    await installer.install({ sourceDir: directory }, { signal });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
