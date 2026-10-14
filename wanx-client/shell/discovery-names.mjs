import { createHash } from 'node:crypto';
import { spawn as spawnProcess } from 'node:child_process';

const SERVICE_UUID = 'f6c7b7a0-5a0f-4b7f-9f3f-4d3f7b5a1000';
const PERIPHERAL_UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const BLUETOOTH_ADDRESS = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const REGISTRY_DEVICE_ID = /^centauros-[0-9a-f]{24,32}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const name = (value) => typeof value === 'string' && value.length > 0 &&
  value.length <= 64 && !CONTROL_CHARACTERS.test(value);

function identity(value) {
  if (!object(value) || Object.keys(value).some((key) => !['deviceId', 'displayName'].includes(key)) ||
    typeof value.deviceId !== 'string' || !/^[A-Za-z0-9._-]{1,36}$/u.test(value.deviceId) ||
    (value.displayName !== undefined && !name(value.displayName))) return undefined;
  const displayName = value.displayName?.trim();
  return { deviceId: value.deviceId, ...(displayName ? { displayName } : {}) };
}

/** Public display hints only; selected GATT identity must still be verified. */
export function createAdvertisementNames({
  helperPath,
  lookupName,
  cacheScope = () => null,
  spawn = spawnProcess,
  platform = process.platform,
  hash = (value) => createHash('sha256').update(value, 'utf8').digest(),
} = {}) {
  const identityCache = new Map();
  return {
    subscribe(onName) {
      if (!['darwin', 'win32'].includes(platform) || typeof helperPath !== 'string' || !helperPath ||
        typeof onName !== 'function') return () => {};
      const scope = cacheScope();
      const now = Date.now();
      for (const [key, entry] of identityCache) if (entry.expiresAt <= now) identityCache.delete(key);
      const known = scope ? [...identityCache.values()].filter((entry) => entry.scope === scope) : [];
      let child;
      try {
        child = spawn(helperPath, platform === 'win32' ? known.map((entry) => `--known=${entry.deviceId}`) : [], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        return () => {};
      }
      let active = true, pending = Buffer.alloc(0), totalBytes = 0, stderrBytes = 0, records = 0;
      const peripherals = new Map(), blocked = new Set(), lastMetadata = new Map(), revocations = new Set();
      const lookedUp = new Set(), resolvedNames = new Map();
      const timer = setTimeout(() => stop(true), platform === 'win32' ? 61000 : 13000);
      timer.unref?.();

      function stop(kill) {
        if (!active) return;
        active = false;
        clearTimeout(timer);
        pending = Buffer.alloc(0);
        peripherals.clear(); blocked.clear(); lastMetadata.clear(); revocations.clear();
        lookedUp.clear(); resolvedNames.clear();
        child.stdout?.removeListener('data', onData);
        child.stdout?.removeListener('error', onError);
        child.stderr?.removeListener('data', onStderr);
        child.stderr?.removeListener('error', onError);
        child.removeListener('close', onClose);
        child.removeListener('error', onError);
        // Termination may deliver a delayed error after this session is gone.
        for (const emitter of [child, child.stdout, child.stderr]) emitter?.once('error', () => {});
        if (kill) {
          try { child.kill('SIGTERM'); } catch { /* Already exited. */ }
        }
      }

      function decode(line) {
        let value;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
        catch { return; }
        const windows = platform === 'win32';
        if (!object(value) || Object.keys(value).some((key) =>
          ![windows ? 'deviceId' : 'peripheralId', 'serviceUuid', 'advertisedName', 'displayIdentity'].includes(key)) ||
          value.serviceUuid !== SERVICE_UUID || !name(value.advertisedName) ||
          (windows ? !BLUETOOTH_ADDRESS.test(value.deviceId) : !PERIPHERAL_UUID.test(value.peripheralId))) return;
        const peripheralId = windows ? value.deviceId.toUpperCase() : value.peripheralId.toUpperCase();
        let deviceId = peripheralId;
        if (!windows) {
          let digest;
          try { digest = hash(peripheralId); } catch { return; }
          if (!Buffer.isBuffer(digest) || digest.length < 6) return;
          // Chromium's macOS provider hashes the uppercase CoreBluetooth UUID.
          deviceId = digest.subarray(0, 6).toString('hex').match(/../g).join(':').toUpperCase();
        }
        if (peripherals.has(deviceId) && peripherals.get(deviceId) !== peripheralId) {
          blocked.add(deviceId);
          if (lastMetadata.has(deviceId)) revocations.add(deviceId);
          lastMetadata.delete(deviceId);
          return;
        }
        if (!peripherals.has(deviceId) && peripherals.size >= 128) { stop(true); return; }
        peripherals.set(deviceId, peripheralId);
        const cached = scope && cacheScope() === scope && identityCache.get(JSON.stringify([scope, deviceId]));
        const displayIdentity = value.displayIdentity === null ? null :
          identity(value.displayIdentity) ?? (cached ? { deviceId: cached.identityId } : undefined);
        return { deviceId, advertisedName: value.advertisedName,
          ...(displayIdentity !== undefined ? { displayIdentity } : {}) };
      }

      function emit(value) {
        try { onName(value); } catch { /* Subscriber errors cannot keep the helper alive. */ }
        const identityId = value.displayIdentity?.deviceId;
        if (!active || typeof lookupName !== 'function' || !REGISTRY_DEVICE_ID.test(identityId || '') ||
          lookedUp.has(identityId)) return;
        lookedUp.add(identityId);
        Promise.resolve().then(() => lookupName(identityId)).then((result) => {
          if (!active || !name(result) || !result.trim()) return;
          const current = lastMetadata.get(value.deviceId);
          if (current?.displayIdentity?.deviceId !== identityId) return;
          const resolved = result.trim();
          if (scope && cacheScope() === scope && REGISTRY_DEVICE_ID.test(identityId)) {
            const key = JSON.stringify([scope, value.deviceId]);
            identityCache.delete(key);
            identityCache.set(key, { scope, deviceId: value.deviceId, identityId, expiresAt: Date.now() + 180000 });
            if (identityCache.size > 128) identityCache.delete(identityCache.keys().next().value);
          }
          resolvedNames.set(identityId, resolved);
          const displayIdentity = { ...current.displayIdentity, displayName: resolved };
          lastMetadata.set(value.deviceId, { ...current, displayIdentity });
          emit({ deviceId: value.deviceId, advertisedName: current.advertisedName, displayIdentity });
        }).catch(() => { /* Discovery keeps the local display hint if lookup is unavailable. */ });
      }

      function onData(chunk) {
        if (!active) return;
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += data.length;
        if (totalBytes > 65536) { stop(true); return; }
        pending = Buffer.concat([pending, data]);
        const batch = [];
        let newline;
        while ((newline = pending.indexOf(0x0a)) !== -1) {
          const line = pending.subarray(0, newline);
          pending = pending.subarray(newline + 1);
          if (line.length > 2048 || ++records > 256) { stop(true); return; }
          const value = decode(line);
          if (!active) return;
          if (value) batch.push(value);
        }
        if (pending.length > 2048) { stop(true); return; }
        // Resolve collisions across the whole batch before exposing any hints.
        for (const deviceId of revocations) {
          if (!active) break;
          emit({ deviceId, advertisedName: null });
        }
        revocations.clear();
        for (const value of batch) {
          if (!active || blocked.has(value.deviceId)) continue;
          const previous = lastMetadata.get(value.deviceId);
          let nextIdentity = value.displayIdentity === null ? undefined :
            value.displayIdentity ?? previous?.displayIdentity;
          if (nextIdentity && resolvedNames.has(nextIdentity.deviceId))
            nextIdentity = { ...nextIdentity, displayName: resolvedNames.get(nextIdentity.deviceId) };
          if (previous?.advertisedName === value.advertisedName &&
            previous?.displayIdentity?.deviceId === nextIdentity?.deviceId &&
            previous?.displayIdentity?.displayName === nextIdentity?.displayName) continue;
          lastMetadata.set(value.deviceId, { advertisedName: value.advertisedName,
            ...(nextIdentity ? { displayIdentity: { ...nextIdentity } } : {}) });
          emit({ ...value,
            ...(value.displayIdentity && nextIdentity ? { displayIdentity: { ...nextIdentity } } : {}) });
        }
      }

      function onStderr(chunk) {
        if (!active) return;
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > 4096) stop(true);
      }
      function onError() { stop(true); }
      function onClose() { stop(false); }
      child.stdout?.on('data', onData);
      child.stdout?.on('error', onError);
      child.stderr?.on('data', onStderr);
      child.stderr?.on('error', onError);
      child.once('error', onError);
      child.once('close', onClose);
      return () => stop(true);
    },
  };
}
