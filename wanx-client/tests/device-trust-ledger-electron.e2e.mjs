// Explicit deep acceptance: node tests/device-trust-ledger-electron.e2e.mjs.
// Three disposable Electron processes, actual vaults/IPC/UI and one real HTTPS
// Python ledger. No normal product entry or real account is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLedgerRuntime } from './ledger-runtime-harness.mjs';

const passphrase = 'synthetic electron local passphrase';
async function desktop(t, directory, role, registerCleanup, runtime) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(fileURLToPath(new URL('../node_modules/.bin/electron', import.meta.url)), [
    fileURLToPath(new URL('./device-trust-ledger-electron.child.mjs', import.meta.url)),
    `--fixture-root=${directory}`, `--role=${role}`,
  ], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let sequence = 0, ended = false, readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (!line.startsWith('TRUST_FIXTURE ')) return;
    const response = JSON.parse(line.slice(14));
    if (response.type === 'ready') { readyResolve(); return; }
    if (response.type === 'startup-error') { readyReject(new Error(response.code)); return; }
    if (response.type === 'namespace-request') {
      const operation = runtime ? runtime.command('wanx.ensure', response.identity) : Promise.reject(new Error('FIXTURE_NAMESPACE_UNAVAILABLE'));
      void operation.then(result => child.stdin.write(`${JSON.stringify({ method: 'namespace-response', id: response.id, ok: true, identity: result.identity })}\n`),
        () => child.stdin.write(`${JSON.stringify({ method: 'namespace-response', id: response.id, ok: false })}\n`));
      return;
    }
    const entry = waiting.get(response.id); if (!entry) return;
    waiting.delete(response.id); clearTimeout(entry.timer);
    if (response.ok) entry.resolve(response.value); else entry.reject(new Error(response.code));
  });
  // Electron may emit platform diagnostics. They are deliberately not echoed;
  // assertions report stages/codes only, with no private document contents.
  child.stderr.resume();
  child.once('exit', () => {
    ended = true; readyReject(new Error('FIXTURE_DESKTOP_EXITED'));
    for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.reject(new Error('FIXTURE_DESKTOP_EXITED')); }
    waiting.clear();
  });
  const command = (method, data = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`FIXTURE_${role.toUpperCase()}_${method.toUpperCase()}_DEADLINE`)); }, 18000);
    waiting.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, ...data })}\n`);
  });
  const close = async () => {
    if (!ended) { await command('close').catch(() => {}); child.stdin.end(); }
    if (!ended) await new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    lines.close();
  };
  registerCleanup(close); t.after(close);
  const startup = setTimeout(() => readyReject(new Error('FIXTURE_DESKTOP_STARTUP_DEADLINE')), 15000);
  try { await ready; } finally { clearTimeout(startup); }
  const action = async (method, data) => { const result = await command(method, data); assert.equal(result.notice, null, `${role} ${method} ${data.form || data.selector}: ${result.errorCode || ''}`); return result; };
  return { command,
    click: selector => action('click', { selector }),
    submit: (form, values) => action('submit', { form, values }),
    text: selector => command('read-public-text', { selector }),
  };
}

test('three real Electron identities complete owner/manager/member approvals, revocation and recovery file configuration', { timeout: 120000 }, async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'wanx-ledger-electron-')));
  const closeDesktops = []; let runtime;
  // Public screenshots are retained for visual verification; remove identities
  // and recovery material even if an assertion fails.
  t.after(async () => {
    await Promise.allSettled(closeDesktops.map(close => close()));
    await runtime?.close();
    for (const name of ['owner', 'manager', 'member', 'recovery-owner.json'])
      await rm(path.join(directory, name), { recursive: true, force: true });
  });
  runtime = await startLedgerRuntime(t);
  const register = close => closeDesktops.push(close);
  const owner = await desktop(t, directory, 'owner', register);
  const manager = await desktop(t, directory, 'manager', register);
  const member = await desktop(t, directory, 'member', register);
  const boxId = runtime.descriptor.boxId;
  for (const target of [owner, manager, member]) await target.submit('createProfile', { passphrase, repeatPassphrase: passphrase });
  await owner.click('[data-view="first-root"]');
  await owner.submit('prepareFirstRoot', { deliveryPacket: runtime.deliveryPacket });
  await owner.submit('confirm-review', { passphrase, reviewed: true });
  await runtime.command('migrate');
  await owner.click('[data-view="security"]');
  await owner.submit('refreshSecurityState', { boxId });
  await owner.submit('prepareActivatePolicy', { 'cap:device.approve_manage': true, 'cap:device.revoke': true,
    'cap:member.invite': true, 'cap:member.revoke': true, 'cap:recovery.configure': true });
  await owner.command('screenshot', { name: 'owner-policy-review.png' });
  await owner.submit('confirm-review', { passphrase, reviewed: true });

  async function enroll(target, operation) {
    await target.click('[data-view="enrollment"]');
    await target.click('[data-action="export-target-info"]');
    const targetInfo = await target.text('textarea[readonly]');
    await owner.click('[data-view="enrollment"]');
    await owner.submit('refreshSecurityState', { boxId });
    await owner.submit('prepare-enrollment', { operation, targetInfo, 'cap:device.approve_use': true,
      'cap:device.revoke': true, 'cap:recovery.configure': true,
      'grant:space:personal:read': true, 'grant:space:personal:write': true,
      'delegate:space:personal:read': true, 'delegate:space:personal:write': true });
    await owner.click('[data-action="export-target-review"]');
    const reviewHandoff = await owner.text('.review textarea[readonly]');
    await target.submit('prepareTargetApproval', { reviewHandoff });
    assert.equal((await target.command('inspect')).overflow, false);
    await target.command('screenshot', { name: `${operation.toLowerCase()}-target-review.png` });
    await target.submit('confirm-review', { passphrase, reviewed: true });
    const targetProofs = await target.text('section.card:has([data-form="acceptEnrollmentReceipt"]) textarea[readonly]');
    await owner.submit('importTargetProofs', { targetProofs });
    await owner.submit('confirm-review', { passphrase, reviewed: true });
    await owner.click('[data-action="export-security-receipt"]');
    const receipt = await owner.text('section[role="status"] textarea[readonly]');
    await target.submit('acceptEnrollmentReceipt', { receipt });
    assert.equal((await target.command('fresh-self', { boxId })).self.active, true);
  }
  await enroll(manager, 'prepareManagerEnrollment');
  await enroll(member, 'prepareMemberInvitation');
  await member.click('[data-view="security"]');
  await member.submit('refreshSecurityState', { boxId });
  assert.equal((await member.command('inspect')).deviceCount, 1);
  const managerBinding = (await manager.command('snapshot')).boxes[0].bindingId;
  await owner.click('[data-view="security"]');
  await owner.submit('refreshSecurityState', { boxId });
  await owner.click(`[data-action="revoke-device"][data-binding-id="${managerBinding}"]`);
  await owner.submit('confirm-review', { passphrase, reviewed: true });
  assert.equal((await manager.command('fresh-self', { boxId })).self.active, false);
  assert.equal((await member.command('fresh-self', { boxId })).self.active, true);
  await owner.command('screenshot', { name: 'revoked-awaiting-data-effect.png' });
  await owner.click('[data-view="recovery"]');
  await owner.submit('beginRecoveryConfiguration', { boxId });
  await owner.click('[data-action="export-recovery-material"]');
  await owner.click('[data-action="reimport-recovery-material"]');
  await owner.click('[data-action="prepare-recovery"]');
  await owner.command('screenshot', { name: 'recovery-configuration-review.png' });
  await owner.submit('confirm-review', { passphrase, reviewed: true });
  await owner.command('system-lock');
  const locked = await owner.command('inspect');
  assert.equal(locked.passwordEmpty, true); assert.equal(locked.reviewVisible, false);
  assert.deepEqual((await owner.command('snapshot')).securityOperations, []);
  t.diagnostic(`Public verification screenshots: ${directory}`);
});

for (const scopeProfile of ['semantica-private-v1', 'wanx-personal-v1']) test(`two real Electron windows complete ${scopeProfile} encrypted backup and new-box restore through native files and HTTPS workers`, { timeout: 120000 }, async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'wanx-ledger-electron-')));
  const closeDesktops = [], runtimes = [];
  t.after(async () => {
    await Promise.allSettled(closeDesktops.map(close => close()));
    await Promise.allSettled(runtimes.map(runtime => runtime.close()));
    for (const runtime of runtimes) if (runtime.diagnostic()) t.diagnostic(runtime.diagnostic());
    for (const name of ['owner', 'member', 'recovery-owner.json', 'recovery-member.json', 'archive-owner.cxb'])
      await rm(path.join(directory, name), { recursive: true, force: true });
  });
  const sourceRuntime = await startLedgerRuntime(t, { backup: true }), targetRuntime = await startLedgerRuntime(t, { backup: true });
  runtimes.push(sourceRuntime, targetRuntime);
  const owner = await desktop(t, directory, 'owner', close => closeDesktops.push(close), sourceRuntime);
  const member = await desktop(t, directory, 'member', close => closeDesktops.push(close), targetRuntime);
  async function setup(client, runtime) {
    const boxId = runtime.descriptor.boxId;
    await client.submit('createProfile', { passphrase, repeatPassphrase: passphrase });
    await client.click('[data-view="first-root"]'); await client.submit('prepareFirstRoot', { deliveryPacket: runtime.deliveryPacket });
    await client.submit('confirm-review', { passphrase, reviewed: true }); await runtime.command('migrate');
    await client.click('[data-view="security"]'); await client.submit('refreshSecurityState', { boxId });
    await client.submit('prepareActivatePolicy', { 'cap:backup.create': true, 'cap:backup.restore': true, 'cap:recovery.configure': true });
    await client.submit('confirm-review', { passphrase, reviewed: true });
    await client.click('[data-view="recovery"]'); await client.submit('beginRecoveryConfiguration', { boxId });
    await client.click('[data-action="export-recovery-material"]'); await client.click('[data-action="reimport-recovery-material"]');
    await client.click('[data-action="prepare-recovery"]'); await client.submit('confirm-review', { passphrase, reviewed: true });
    return (await client.command('fresh-self', { boxId })).self;
  }
  const sourceSelf = await setup(owner, sourceRuntime), targetSelf = await setup(member, targetRuntime);
  const wanx = scopeProfile === 'wanx-personal-v1';
  const sourceSeed = await sourceRuntime.command(wanx ? 'wanx.seed' : 'backup.seed', { principalId: sourceSelf.principalId });
  const targetSeed = await targetRuntime.command(wanx ? 'wanx.seed' : 'backup.seed', { principalId: targetSelf.principalId, otherOnly: true });
  const boxId = sourceRuntime.descriptor.boxId;
  await owner.click('[data-view="backup"]'); await owner.submit('refreshBackupTargets', { boxId });
  await owner.submit('prepareBackupCreate', { targetId: 'local-managed', scopeProfile, includeBusinessSecrets: false });
  await owner.command('screenshot', { name: 'backup-scope-review.png' });
  await owner.submit('confirm-review', { passphrase, reviewed: true });
  assert.match((await owner.command('inspect')).statusText, /已批准业务任务/);
  await sourceRuntime.command('backup.run');
  await owner.click('[data-action="refresh-backup-operation"]');
  assert.match((await owner.command('inspect')).statusText, /备份已持久保存在同一盒子/);
  await owner.click('[data-action="save-backup-archive"]');
  await owner.command('screenshot', { name: 'backup-verified-native-copy.png' });
  assert.match((await owner.command('inspect')).statusText, /已实际另存并校验完整摘要/);
  await member.command('file-choice', { name: 'recovery-owner.json' });
  await member.click('[data-view="backup"]'); await member.submit('importBackupSource', { boxId });
  await member.click('[data-action="prepare-backup-restore"]');
  const restoreReview = (await member.command('inspect')).reviewText;
  for (const text of ['来源盒子', sourceRuntime.descriptor.baseUrl, '目标盒子', targetRuntime.descriptor.baseUrl, '备份创建时间', '加密备份大小'])
    assert.ok(restoreReview.includes(text));
  await member.command('screenshot', { name: 'restore-source-target-review.png' });
  assert.equal((await member.command('inspect')).overflow, false);
  await member.submit('confirm-review', { passphrase, reviewed: true });
  await targetRuntime.command('backup.run');
  await member.click('[data-action="refresh-backup-operation"]');
  assert.match((await member.command('inspect')).statusText, /解密密钥/);
  await member.click('[data-action="provide-restore-key"]');
  await targetRuntime.command('backup.run');
  await member.click('[data-action="refresh-backup-operation"]');
  assert.match((await member.command('inspect')).statusText, /业务数据还原已验证完成/);
  await member.command('screenshot', { name: 'restore-completed.png' });
  const checked = await targetRuntime.command(wanx ? 'wanx.inspect' : 'backup.inspect', wanx ? { principalId: targetSelf.principalId } : {});
  if (wanx) {
    assert.deepEqual(checked.files, sourceSeed.files); assert.deepEqual(checked.items, sourceSeed.items); assert.deepEqual(checked.note, sourceSeed.note);
    assert.equal(checked.namespace, targetSeed.namespace); assert.notEqual(checked.namespace, sourceSeed.namespace);
    assert.equal(checked.otherSha256, targetSeed.otherSha256); assert.equal(checked.agentLinks, 0); assert.equal(checked.replayBatches, 0);
  } else {
    assert.equal(checked.documents['fixture-doc'].sha256, sourceSeed.sha256);
    assert.equal(checked.documents['fixture-doc'].workspace, targetSeed.workspace);
    assert.equal(checked.documents['other-doc'].workspace, 'other-principal');
  }
  assert.equal((await member.command('fresh-self', { boxId })).self.active, true);
  await member.command('system-lock');
  assert.equal((await member.command('inspect')).passwordEmpty, true);
  t.diagnostic(`Public backup verification screenshots: ${directory}`);
});

test('real Electron transfer shows freeze and interrupted erase before new epoch owner binds with fresh delivery', { timeout: 120000 }, async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'wanx-ledger-electron-')));
  const closeDesktops = [], runtime = await startLedgerRuntime(t, { transfer: true });
  t.after(async () => {
    await Promise.allSettled(closeDesktops.map(close => close())); await runtime.close();
    if (runtime.diagnostic()) t.diagnostic(runtime.diagnostic());
    for (const name of ['owner', 'member']) await rm(path.join(directory, name), { recursive: true, force: true });
  });
  const owner = await desktop(t, directory, 'owner', close => closeDesktops.push(close));
  const next = await desktop(t, directory, 'member', close => closeDesktops.push(close));
  const boxId = runtime.descriptor.boxId;
  for (const client of [owner, next]) await client.submit('createProfile', { passphrase, repeatPassphrase: passphrase });
  await owner.click('[data-view="first-root"]'); await owner.submit('prepareFirstRoot', { deliveryPacket: runtime.deliveryPacket });
  await owner.submit('confirm-review', { passphrase, reviewed: true }); await runtime.command('migrate');
  await owner.click('[data-view="security"]'); await owner.submit('refreshSecurityState', { boxId });
  await owner.submit('prepareActivatePolicy', { 'cap:ownership.transfer': true });
  await owner.submit('confirm-review', { passphrase, reviewed: true });
  await owner.click('[data-view="transfer"]'); await owner.submit('prepareOwnershipTransfer', { boxId });
  assert.match((await owner.command('inspect')).reviewText, /所有已绑定成员/);
  await owner.command('screenshot', { name: 'transfer-erase-scope-review.png' });
  assert.equal((await owner.command('inspect')).overflow, false);
  await owner.submit('confirm-review', { passphrase, reviewed: true, eraseConfirmation: '清除本地数据' });
  const committedView = await owner.command('inspect');
  assert.match(committedView.statusText, /不表示数据已擦除/, committedView.networkError || 'commit result');
  const requestId = (await owner.command('snapshot')).securityOperations.find(value => value.action === 'ownership.transfer-prepare').requestId;
  const frozen = await owner.command('fresh-transfer', { boxId, requestId }), transferId = frozen.transferStatus.transferId;
  assert.equal((await runtime.command('transfer.prepare', { transferId })).ok, false);
  await owner.click('[data-action="refresh-transfer-status"]');
  await owner.command('screenshot', { name: 'transfer-frozen-awaiting-os.png' });
  await runtime.command('transfer.authorize', { transferId });
  const prepared = await runtime.command('transfer.prepare', { transferId }); assert.equal(prepared.ok, true, prepared.code);
  await runtime.command('restart');
  await owner.click('[data-action="refresh-transfer-status"]');
  assert.equal((await owner.command('fresh-transfer', { boxId, requestId })).transferStatus.state, 'erase_pending');
  await owner.command('screenshot', { name: 'transfer-interrupted-erase-pending.png' });
  const finished = await runtime.command('transfer.finish', { transferId }); assert.equal(finished.ok, true, finished.code);
  await owner.click('[data-action="refresh-transfer-status"]');
  const ready = await owner.command('fresh-transfer', { boxId, requestId }); assert.equal(ready.transferStatus.state, 'redelivery_ready');
  await owner.command('screenshot', { name: 'transfer-redelivery-ready.png' });
  const checked = await runtime.command('transfer.inspect', { transferId }); assert.equal(checked.privateFilesRemaining, 0);
  await next.click('[data-view="first-root"]'); await next.submit('prepareFirstRoot', { deliveryPacket: checked.deliveryPacket });
  await next.command('screenshot', { name: 'transfer-new-epoch-root-review.png' });
  await next.submit('confirm-review', { passphrase, reviewed: true });
  assert.equal((await next.command('fresh-self', { boxId })).self.active, true);
  assert.equal((await owner.command('fresh-self', { boxId })).self.active, false);
  assert.deepEqual((await owner.command('fresh-transfer', { boxId, requestId })).transferStatus, ready.transferStatus);
  await next.command('screenshot', { name: 'transfer-new-owner-active.png' });
  t.diagnostic(`Public transfer verification screenshots: ${directory}`);
});
