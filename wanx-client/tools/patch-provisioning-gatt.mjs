import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Reproducible local patch of the pinned SDK; never patch node_modules in place.
const root = fileURLToPath(new URL('../', import.meta.url));
const version = '2.0.1-wanx.1';
const archive = path.join(root, 'vendor/nexusaos-local-provisioning-electron-ble-2.0.1.tgz');
const check = process.argv.includes('--check');
if (process.argv.slice(2).some(arg => arg !== '--check')) throw Error('Only --check is supported');
const sha256 = data => createHash('sha256').update(data).digest('hex');
if (sha256(readFileSync(archive)) !== '3a321b54ac255904b190b9b772282999f2e62677806b1f624f18dfedf8f0e248') {
  throw Error('SDK baseline hash mismatch: electron-ble');
}
const temporary = mkdtempSync(path.join(os.tmpdir(), 'wanx-provisioning-gatt-'));
try {
  const directory = path.join(temporary, 'package');
  mkdirSync(directory);
  for (const entry of execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n')) {
    if (!/^package\/(?:package\.json|README\.md|dist\/[a-z]+\.js|dist\/[a-z]+\.d\.ts)$/.test(entry)) {
      throw Error(`Unexpected SDK archive member: ${entry}`);
    }
    const destination = path.join(temporary, entry);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, execFileSync('tar', ['-xOzf', archive, entry]), { mode: 0o644 });
  }
  const manifestPath = path.join(directory, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== '@nexusaos/local-provisioning-electron-ble' || manifest.version !== '2.0.1') {
    throw Error('Unexpected SDK package identity');
  }
  manifest.version = version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  const target = path.join(directory, 'dist/index.js');
  const source = readFileSync(target, 'utf8');
  const before = `            let server, service, deviceInfo, command, status;
            try {
                server = await device.gatt.connect();
                service = await server.getPrimaryService(PROVISIONING_SERVICE_UUID);
                [deviceInfo, command, status] = await Promise.all([
                    service.getCharacteristic(DEVICE_INFO_UUID),
                    service.getCharacteristic(COMMAND_UUID),
                    service.getCharacteristic(STATUS_UUID),
                ]);
            }
            catch {
                device.gatt.disconnect();
                throw new LocalProvisioningFailure("GATT_CHARACTERISTIC_MISMATCH");
            }`;
  const after = `            let server, service, deviceInfo, command, status;
            let stage = "connect";
            const assertActive = () => {
                if (signal.aborted)
                    throw new DOMException("Aborted", "AbortError");
            };
            try {
                server = await device.gatt.connect();
                assertActive();
                stage = "service";
                service = await server.getPrimaryService(PROVISIONING_SERVICE_UUID);
                assertActive();
                stage = "characteristic";
                // Web Bluetooth backends may allow only one GATT operation at a time.
                deviceInfo = await service.getCharacteristic(DEVICE_INFO_UUID);
                assertActive();
                command = await service.getCharacteristic(COMMAND_UUID);
                assertActive();
                status = await service.getCharacteristic(STATUS_UUID);
                assertActive();
            }
            catch (error) {
                device.gatt.disconnect();
                if (signal.aborted || error?.name === "AbortError")
                    throw new DOMException("Aborted", "AbortError");
                const code = error?.name === "NotFoundError" && stage !== "connect"
                    ? (stage === "service" ? "GATT_SERVICE_NOT_FOUND" : "GATT_CHARACTERISTIC_MISMATCH")
                    : "LOCAL_TRANSPORT_DISCONNECTED";
                throw new LocalProvisioningFailure(code);
            }`;
  if (source.split(before).length !== 2) throw Error('SDK GATT patch anchor is not unique');
  writeFileSync(target, source.replace(before, after));
  const packed = JSON.parse(execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', temporary],
    { cwd: directory, encoding: 'utf8' }));
  const filename = `nexusaos-local-provisioning-electron-ble-${version}.tgz`;
  if (packed.length !== 1 || packed[0].filename !== filename) throw Error('Unexpected packed SDK filename');
  const generated = path.join(temporary, filename), destination = path.join(root, 'vendor', filename);
  if (check) {
    if (!readFileSync(destination).equals(readFileSync(generated))) throw Error('SDK GATT patch is not reproducible');
  } else renameSync(generated, destination);
  console.log(`${check ? 'Verified' : 'Built'} ${filename} ${sha256(readFileSync(destination))}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
