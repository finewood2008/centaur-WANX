import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDeviceTrustCoordinator } from '../device-trust/coordinator.mjs';
import { createRecoveryFiles } from '../shell/recovery-files.mjs';
import { createBackupFiles } from '../shell/backup-files.mjs';
import { createPinnedTransport } from '../device-trust/pinned-transport.mjs';
import { startLedgerRuntime } from './ledger-runtime-harness.mjs';

const passphrase = 'synthetic backup desktop passphrase';
async function roundtrip(t, documentBytes, scopeProfile = 'semantica-private-v1') {
  const sourceRuntime = await startLedgerRuntime(t, { backup: true });
  const targetRuntime = await startLedgerRuntime(t, { backup: true });
  t.after(() => { for (const runtime of [sourceRuntime, targetRuntime]) if (runtime.diagnostic()) t.diagnostic(runtime.diagnostic()); });
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'desktop-backup-https-')));
  const close = [];
  t.after(async () => { for (const item of close.reverse()) await item(); await rm(directory, { recursive: true, force: true }); });
  const sourceMaterial = path.join(directory, 'source-recovery.json'), archive = path.join(directory, 'archive.cxb');
  async function setup(runtime, label) {
    let materialPath = path.join(directory, `${label}-recovery.json`);
    let archivePath = archive;
    const networkPaths = [];
    const files = createRecoveryFiles({ dialog: {
      showSaveDialog: async () => ({ canceled: false, filePath: materialPath }),
      showOpenDialog: async () => ({ canceled: false, filePaths: [materialPath] }),
    } });
    const backupFiles = createBackupFiles({ dialog: {
      showSaveDialog: async () => ({ canceled: false, filePath: archive }),
      showOpenDialog: async () => ({ canceled: false, filePaths: [archivePath] }),
    } });
    const rawService = await createDeviceTrustCoordinator({ directory: path.join(directory, label), files, backupFiles,
      ensureBackupNamespace: ({ signal, ...identity }) => { signal.throwIfAborted(); return runtime.command('wanx.ensure', identity).then(result => result.identity); },
      ledgerTransportFactory: descriptor => {
        const transport = createPinnedTransport({ descriptor, protocolVersion: 2 });
        return { request: (route, ...args) => { networkPaths.push(route); return transport.request(route, ...args); } };
      } });
    const service = new Proxy(rawService, { get(object, name) { const method = object[name]; return typeof method !== 'function' ? method : async (...args) => {
      try { return await method(...args); } catch (error) { throw new Error(`${label}.${String(name)}: ${error.code || error.message}`, { cause: error }); }
    }; } });
    close.push(() => service.close(), () => files.close(), () => backupFiles.close());
    await service.createProfile({ passphrase });
    const root = await service.prepareFirstRoot({ deliveryPacket: runtime.deliveryPacket });
    await service.confirmFirstRoot({ reviewHandle: root.reviewHandle, passphrase });
    await runtime.command('migrate');
    const boxId = runtime.descriptor.boxId;
    const activation = await service.prepareActivatePolicy({ boxId, capabilities: ['backup.create', 'backup.restore', 'device.approve_use', 'recovery.configure'] });
    assert.equal((await service.confirmSecurityMutation({ reviewHandle: activation.reviewHandle, passphrase })).state, 'committed');
    const material = await service.beginRecoveryConfiguration({ boxId });
    await service.exportRecoveryMaterial({ materialHandle: material.materialHandle });
    await service.reimportRecoveryMaterial({ materialHandle: material.materialHandle });
    const review = await service.prepareRecoveryConfiguration({ materialHandle: material.materialHandle });
    assert.equal((await service.confirmSecurityMutation({ reviewHandle: review.reviewHandle, passphrase })).state, 'committed');
    return { service, boxId, networkPaths, selectSourceMaterial() { materialPath = sourceMaterial; }, selectArchive(file) { archivePath = file; } };
  }
  const source = await setup(sourceRuntime, 'source'), target = await setup(targetRuntime, 'target');
  const sourceState = await source.service.refreshSecurityState({ boxId: source.boxId });
  const targetState = await target.service.refreshSecurityState({ boxId: target.boxId });
  // Populate real SQLite anonymous issuance to its exact capacity. All following
  // operations still use actual HTTPS with finite Access PoP challenge proofs.
  for (const runtime of [sourceRuntime, targetRuntime]) {
    const saturated = await runtime.command('challenge.saturate');
    assert.equal(saturated.capacityRejected, true); assert.ok(saturated.issued > 0);
  }
  const wanx = scopeProfile === 'wanx-personal-v1';
  const seeded = await sourceRuntime.command(wanx ? 'wanx.seed' : 'backup.seed', { principalId: sourceState.self.principalId, ...(documentBytes ? { documentBytes } : {}) });
  const seededTarget = await targetRuntime.command(wanx ? 'wanx.seed' : 'backup.seed', { principalId: targetState.self.principalId, otherOnly: true });
  const catalog = await source.service.refreshBackupTargets({ boxId: source.boxId });
  assert.equal(catalog.targets[0].durability, 'same-box');
  assert.ok(catalog.targets[0].scopeProfiles.includes(scopeProfile));
  const create = await source.service.prepareBackupCreate({ boxId: source.boxId, targetId: 'local-managed', scopeProfile, includeBusinessSecrets: false });
  assert.equal((await source.service.confirmSecurityMutation({ reviewHandle: create.reviewHandle, passphrase })).state, 'committed');
  assert.equal((await source.service.refreshBackupOperation({ boxId: source.boxId, requestId: create.requestId })).status.state, 'queued');
  await sourceRuntime.command('backup.run');
  const created = await source.service.refreshBackupOperation({ boxId: source.boxId, requestId: create.requestId });
  assert.equal(created.status.state, 'completed', JSON.stringify(created.status) + sourceRuntime.diagnostic());
  const saved = await source.service.saveBackupArchive({ boxId: source.boxId, requestId: create.requestId });
  assert.equal(saved.localCopy.verified, true); assert.ok((await stat(archive)).size > 1048576);
  target.selectSourceMaterial();
  if (!documentBytes) {
    // A mistaken native selection must never send the actual offline private
    // recovery material, even to the already pinned target box.
    target.selectArchive(sourceMaterial);
    await assert.rejects(target.service.importBackupSource({ boxId: target.boxId }), /SOURCE_INVALID/);
    assert.equal(target.networkPaths.filter(route => route.startsWith('/backup-io/source.')).length, 0);
    const changed = path.join(directory, 'changed-archive.cxb'); await copyFile(archive, changed);
    const fd = await open(changed, 'r+');
    try {
      const length = Buffer.alloc(4), byte = Buffer.alloc(1); await fd.read(length, 0, 4, 8);
      const offset = 12 + length.readUInt32BE() + 4; await fd.read(byte, 0, 1, offset);
      byte[0] ^= 1; await fd.write(byte, 0, 1, offset);
    } finally { await fd.close(); }
    target.selectArchive(changed);
    await assert.rejects(target.service.importBackupSource({ boxId: target.boxId }), /SOURCE_INVALID/);
    assert.equal(target.networkPaths.filter(route => route.startsWith('/backup-io/source.')).length, 0);
    target.selectArchive(archive);
  }
  const imported = await target.service.importBackupSource({ boxId: target.boxId });
  assert.equal(imported.sourcePrincipalId, sourceState.self.principalId);
  assert.equal(imported.targetPrincipalId, targetState.self.principalId);
  const restore = await target.service.prepareBackupRestore({ sourceHandle: imported.sourceHandle });
  assert.deepEqual(restore.backupSource.source, { boxId: sourceRuntime.descriptor.boxId, baseUrl: sourceRuntime.descriptor.baseUrl });
  assert.deepEqual(restore.backupSource.target, { boxId: targetRuntime.descriptor.boxId, baseUrl: targetRuntime.descriptor.baseUrl });
  assert.equal(restore.backupSource.archiveBytes, (await stat(archive)).size);
  assert.ok(Number.isSafeInteger(restore.backupSource.createdAt));
  assert.equal((await target.service.confirmSecurityMutation({ reviewHandle: restore.reviewHandle, passphrase })).state, 'committed');
  await targetRuntime.command('backup.run');
  assert.equal((await target.service.refreshBackupOperation({ boxId: target.boxId, requestId: restore.requestId })).status.phase, 'awaiting_key');
  assert.equal((await target.service.provideRestoreKey({ boxId: target.boxId, requestId: restore.requestId })).keyReceived, true);
  await targetRuntime.command('backup.run');
  const restored = await target.service.refreshBackupOperation({ boxId: target.boxId, requestId: restore.requestId });
  assert.equal(restored.status.state, 'completed', JSON.stringify(restored.status) + targetRuntime.diagnostic());
  const inspected = await targetRuntime.command(wanx ? 'wanx.inspect' : 'backup.inspect', wanx ? { principalId: targetState.self.principalId } : {});
  if (wanx) {
    assert.deepEqual(inspected.files, seeded.files); assert.deepEqual(inspected.items, seeded.items); assert.deepEqual(inspected.note, seeded.note);
    assert.equal(inspected.namespace, seededTarget.namespace); assert.notEqual(inspected.namespace, seeded.namespace);
    assert.equal(inspected.otherSha256, seededTarget.otherSha256); assert.equal(inspected.agentLinks, 0); assert.equal(inspected.replayBatches, 0);
  } else {
    assert.equal(inspected.documents['fixture-doc'].sha256, seeded.sha256);
    assert.equal(inspected.documents['fixture-doc'].workspace, seededTarget.workspace);
    assert.equal(inspected.documents['other-doc'].workspace, 'other-principal');
  }
  const after = await target.service.refreshSecurityState({ boxId: target.boxId });
  assert.deepEqual(after.devices, targetState.devices); assert.deepEqual(after.grants, targetState.grants);
  assert.deepEqual(after.recovery, targetState.recovery); assert.equal(after.self.active, true);
  await targetRuntime.command('restart');
  assert.deepEqual((await target.service.refreshBackupOperation({ boxId: target.boxId, requestId: restore.requestId })).status, restored.status);
  for (const endpoint of [source, target]) {
    assert.ok(endpoint.networkPaths.includes('/authenticated-challenge'));
    assert.ok(endpoint.networkPaths.includes('/mutations/authenticated-challenge'));
    assert.equal(endpoint.networkPaths.includes('/auth/challenge'), false);
    assert.equal(endpoint.networkPaths.includes('/mutations/challenge'), false);
  }
}
test('desktop native files and pinned HTTPS roundtrip real private SQLite/binary backup between independent boxes', t => roundtrip(t));
test('WANX native personal files, note, images and two SQLite stores restore into an independent principal over HTTPS', t => roundtrip(t, undefined, 'wanx-personal-v1'));
test('near 200 MiB limit completes fresh per-chunk proofs and actual native download/upload', { timeout: 180000 },
  t => roundtrip(t, 196 * 1048576));
