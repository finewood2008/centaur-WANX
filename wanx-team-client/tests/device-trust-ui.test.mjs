import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDeviceTrustView, renderDeviceTrust } from '../local-ui/device-trust/view.mjs';

const base = () => ({ profile: { locked: false, principalId: 'principal-1', clientId: 'client-1', keyProtection: 'software-passphrase-v1' }, boxes: [{ boxId: 'box-1', role: 'root' }], window: { view: 'overview' } });
const review = kind => ({ kind, reviewHandle: 'opaque-handle', boxId: 'box-1', boxKeyThumbprint: 'box-fingerprint', principalId: 'principal-1', clientId: 'client-2', accessKeyThumbprint: 'device-fingerprint', role: kind === 'first-root' ? 'root' : 'use', grants: [{ resourceId: 'space:personal', actions: ['read'] }], expiresAt: 2000000000, grantExpiresAt: null, ownershipEpoch: 1, rosterVersion: 3, requestDigest: 'immutable-request-digest', approverBindingId: kind === 'approval' ? 'manager-binding' : undefined });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function harness(t, state = base(), overrides = {}) {
  const events = new Map(), calls = [];
  let changed;
  const root = { innerHTML: '', contains: () => true, addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) };
  const api = { snapshot: async () => state, onChanged: fn => { changed = fn; return () => { changed = undefined; }; },
    createProfile: async input => { calls.push(['createProfile', input]); state = base(); },
    unlock: async input => { calls.push(['unlock', input]); state.profile.locked = false; },
    lock: async () => { calls.push(['lock']); state.profile.locked = true; },
    prepareFirstRoot: async input => { calls.push(['prepareFirstRoot', input]); return review('first-root'); },
    prepareJoin: async input => { calls.push(['prepareJoin', input]); return review('join'); },
    prepareApproval: async input => { calls.push(['prepareApproval', input]); return review('approval'); },
    confirmFirstRoot: async input => { calls.push(['confirmFirstRoot', input]); return { boxId: 'box-1', requestId: 'request-1', state: 'approved', ack: { requestId: 'request-1', bindingId: 'root-binding', rosterVersion: 1 } }; },
    confirmApproval: async input => { calls.push(['confirmApproval', input]); return { boxId: 'box-1', requestId: 'request-1', state: 'approved', ack: { requestId: 'request-1', bindingId: 'use-binding', rosterVersion: 4 } }; },
    submitJoin: async input => { calls.push(['submitJoin', input]); return { boxId: 'box-1', requestId: 'request-1', state: 'pending', invitation: 'public-invitation' }; },
    refreshRequest: async input => { calls.push(['refreshRequest', input]); return { ...input, state: 'pending' }; },
    cancelRequest: async input => { calls.push(['cancelRequest', input]); return { ...input, state: 'cancelled' }; },
    refreshDevices: async input => { calls.push(['refreshDevices', input]); return { ...input, devices: [{ bindingId: 'binding-1', clientId: 'client-2', role: 'use', status: 'active', accessKeyThumbprint: 'access-fingerprint' }], recoveryConfigured: false }; },
    exportJoinInfo: async input => { calls.push(['exportJoinInfo', input]); return { joinInfo: 'public-join-material' }; }, ...overrides,
  };
  class TestFormData { constructor(form) { return Object.entries(form.values); } }
  const view = createDeviceTrustView({ root, api, FormDataClass: TestFormData });
  t.after(() => view.dispose()); await view.ready;
  return { root, calls, api, state, changed: () => changed?.(),
    click: async dataset => events.get('click')({ target: { closest: () => ({ dataset }) } }),
    async submit(name, values, submitterValue) {
      const form = { dataset: { form: name }, values, reset() { this.values = {}; this.wasReset = true; } };
      const promise = events.get('submit')({ target: form, preventDefault() {}, submitter: { value: submitterValue } });
      return { form, promise };
    },
  };
}

test('UI starts local identity without cloud account and accurately states software protection', async t => {
  const h = await harness(t, { profile: null, boxes: [], window: { view: 'overview' } });
  assert.match(h.root.innerHTML, /建立独立本地身份/);
  assert.match(h.root.innerHTML, /软件口令保护/);
  assert.match(h.root.innerHTML, /密钥由本地口令加密保存/);
  assert.match(h.root.innerHTML, /本地绑定与现有数据访问权限分别管理/);
  const { form, promise } = await h.submit('createProfile', { passphrase: 'private-local-passphrase', repeatPassphrase: 'private-local-passphrase' });
  assert.equal(form.wasReset, true); await promise;
  assert.deepEqual(h.calls[0], ['createProfile', { passphrase: 'private-local-passphrase' }]);
  assert.doesNotMatch(h.root.innerHTML, /private-local-passphrase/);
  assert.match(h.root.innerHTML, /选择接下来要做的事/);
});

test('different creation passwords are cleared and never sent to main', async t => {
  const h = await harness(t, { profile: null, boxes: [] });
  const { promise } = await h.submit('createProfile', { passphrase: 'private-one', repeatPassphrase: 'private-two' }); await promise;
  assert.equal(h.calls.length, 0);
  assert.match(h.root.innerHTML, /两次输入的本地口令不一致/);
  assert.doesNotMatch(h.root.innerHTML, /private-one|private-two/);
});

test('unreadable identity never offers creation or unlock over existing storage', async t => {
  const h = await harness(t, { profile: null, error: 'LOCAL_IDENTITY_CORRUPT', boxes: [] });
  assert.match(h.root.innerHTML, /本地身份暂时不可读取/);
  assert.match(h.root.innerHTML, /请保留现有身份文件/);
  assert.doesNotMatch(h.root.innerHTML, /data-form="createProfile"|data-form="unlock"/);
  assert.equal(h.calls.length, 0);
});

for (const [code, guidance] of [
  ['LOCAL_IDENTITY_PASSPHRASE_INVALID', '至少需要 12 个字符'],
  ['LOCAL_IDENTITY_UNLOCK_FAILED', '无法解锁本地身份'],
  ['LOCAL_IDENTITY_LOCKED', '请重新解锁'],
  ['LOCAL_TRUST_CLOCK_ROLLBACK', '检测到时间回退'],
  ['LOCAL_TRUST_ALREADY_OWNED', '盒子已有本地主人'],
]) test(`known ${code} failure has actionable guidance`, async t => {
  // Real contextBridge preserves Error.message, but not custom Error.code.
  const h = await harness(t, base(), { prepareFirstRoot: async () => { throw new Error(code); } });
  const task = await h.submit('prepareFirstRoot', { deliveryPacket: 'test-packet' }); await task.promise;
  assert.ok(h.root.innerHTML.includes(guidance));
});

test('first binding clears delivery secret before awaiting main and requires an explicit review', async t => {
  const pending = deferred();
  const h = await harness(t, base(), { prepareFirstRoot: async input => { h.calls.push(['prepareFirstRoot', input]); return pending.promise; } });
  await h.click({ view: 'first-root' });
  const { form, promise } = await h.submit('prepareFirstRoot', { deliveryPacket: 'private-delivery-secret' });
  assert.equal(form.wasReset, true);
  assert.doesNotMatch(h.root.innerHTML, /private-delivery-secret/);
  pending.resolve(review('first-root')); await promise;
  assert.match(h.root.innerHTML, /box-fingerprint/);
  assert.match(h.root.innerHTML, /space:personal/);
  assert.match(h.root.innerHTML, /软件口令保护/);
  const unchecked = await h.submit('confirm-review', { passphrase: 'private-passphrase' }); await unchecked.promise;
  assert.equal(h.calls.length, 1);
  const checked = await h.submit('confirm-review', { passphrase: 'private-passphrase', reviewed: 'on' }); await checked.promise;
  assert.deepEqual(h.calls[1], ['confirmFirstRoot', { reviewHandle: 'opaque-handle', passphrase: 'private-passphrase' }]);
  assert.match(h.root.innerHTML, /盒子已确认绑定/);
  assert.doesNotMatch(h.root.innerHTML, /private-passphrase/);
});

test('join sends only a review handle and waits for authority receipt before showing success', async t => {
  const h = await harness(t);
  let pending = await h.submit('prepareJoin', { joinInfo: 'public-join' }); await pending.promise;
  assert.match(h.root.innerHTML, /申请此设备的使用权限/);
  assert.doesNotMatch(h.root.innerHTML, /name="passphrase"/);
  pending = await h.submit('confirm-review', { reviewed: 'on' }); await pending.promise;
  assert.deepEqual(h.calls.at(-1), ['submitJoin', { reviewHandle: 'opaque-handle' }]);
  assert.match(h.root.innerHTML, /等待管理设备批准/);
  assert.match(h.root.innerHTML, /public-invitation/);
  assert.doesNotMatch(h.root.innerHTML, /盒子已确认绑定/);
  await h.click({ action: 'cancel-request', boxId: 'box-1', requestId: 'request-1' });
  assert.match(h.root.innerHTML, /已取消/);
});

test('approval displays immutable grant and approver details and never accepts an edited payload', async t => {
  const h = await harness(t);
  let pending = await h.submit('prepareApproval', { invitation: 'public-invitation' }); await pending.promise;
  for (const value of ['device-fingerprint', 'manager-binding', 'immutable-request-digest', 'space:personal', '设备清单版本']) assert.ok(h.root.innerHTML.includes(value));
  pending = await h.submit('confirm-review', { reviewed: 'on', passphrase: 'per-operation-password', trustedState: 'fake', verified: 'true', requestDigest: 'altered' }); await pending.promise;
  assert.deepEqual(h.calls.at(-1), ['confirmApproval', { reviewHandle: 'opaque-handle', passphrase: 'per-operation-password' }]);
  assert.match(h.root.innerHTML, /盒子已确认绑定/);
});

test('locked lifecycle event immediately clears a review and fences a delayed approval', async t => {
  const pending = deferred();
  const h = await harness(t, base(), { confirmApproval: async () => pending.promise });
  let task = await h.submit('prepareApproval', { invitation: 'public' }); await task.promise;
  task = await h.submit('confirm-review', { reviewed: 'on', passphrase: 'private-passphrase' });
  h.state.profile.locked = true;
  h.changed();
  assert.doesNotMatch(h.root.innerHTML, /immutable-request-digest|private-passphrase/);
  assert.match(h.root.innerHTML, /解锁这台设备/);
  pending.resolve({ state: 'approved', ack: { bindingId: 'late-binding', requestId: 'late-request' } });
  await task.promise;
  assert.doesNotMatch(h.root.innerHTML, /late-binding|盒子已确认绑定/);
});

test('device list and export use explicit box context and show use-device limitations', async t => {
  const state = base(); state.window = { view: 'devices', boxId: 'box-1' };
  const h = await harness(t, state);
  assert.match(h.root.innerHTML, /value="box-1" selected/);
  let task = await h.submit('refreshDevices', { boxId: 'box-1' }); await task.promise;
  assert.match(h.root.innerHTML, /client-2|使用设备|access-fingerprint/);
  task = await h.submit('refreshDevices', { boxId: 'box-1' }, 'exportJoinInfo'); await task.promise;
  assert.deepEqual(h.calls.at(-1), ['exportJoinInfo', { boxId: 'box-1' }]);
  assert.match(h.root.innerHTML, /public-join-material/);
});

test('untrusted names and resource identifiers are escaped and no secret proof is rendered', () => {
  const state = base();
  const value = review('approval');
  value.clientId = '<img src=x onerror=evil()>';
  value.grants[0].resourceId = '<script>evil()</script>';
  value.secretProof = 'never-display-secret-proof';
  const html = renderDeviceTrust({ snapshot: state, view: 'approval', review: value });
  assert.doesNotMatch(html, /<img|<script|never-display-secret-proof/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script/);
});

test('persisted uncertain operation is reachable after reopening and locks hide its history', async t => {
  const state = base(); state.securityOperations = [{ boxId: 'box-1', requestId: 'saved-request', action: 'recovery.rotate', state: 'outcome_unknown' }];
  const h = await harness(t, state, { refreshSecurityMutation: async input => {
    h.calls.push(['refreshSecurityMutation', input]); return { ...input, state: 'outcome_unknown', ack: null, self: null, dataEffect: null };
  } });
  assert.match(h.root.innerHTML, /本机安全操作记录/);
  assert.match(h.root.innerHTML, /提交结果待核实/);
  await h.click({ action: 'refresh-security-operation', boxId: 'box-1', requestId: 'saved-request' });
  assert.deepEqual(h.calls.at(-1), ['refreshSecurityMutation', { boxId: 'box-1', requestId: 'saved-request' }]);
  assert.match(h.root.innerHTML, /不要重复生成新申请或恢复材料/);
  assert.doesNotMatch(h.root.innerHTML, /盒子已确认绑定/);
  h.state.profile.locked = true; h.changed();
  assert.doesNotMatch(h.root.innerHTML, /saved-request|本机安全操作记录/);
});

test('management ACK and recovery configuration never imply closed data streams or restored files', () => {
  const html = renderDeviceTrust({ snapshot: base(), view: 'overview', result: {
    securityOperation: true, boxId: 'box-1', requestId: 'saved-request', state: 'committed', self: null,
    recoveryOutcome: 'configuration-committed', dataEffect: { effectState: 'unknown' },
  } });
  assert.match(html, /尚无完整关闭证据/);
  assert.match(html, /不表示已创建或恢复业务数据备份/);
  assert.match(html, /本机当前状态/);
  assert.doesNotMatch(html, /已确认关闭|盒子已确认绑定/);
});

test('backup job, verified same-box archive and actual native copy are distinct visible results', () => {
  const result = { backupOperation: true, boxId: 'box-1', requestId: 'job', status: {
    operationId: 'job', state: 'running', phase: 'encrypting', errorCode: null, recoveryRequired: false, result: null } };
  const render = () => renderDeviceTrust({ snapshot: base(), view: 'backup', result });
  assert.doesNotMatch(render(), /盒子已生成加密备份|已实际另存/);
  result.status = { ...result.status, state: 'completed', phase: 'complete', result: { type: 'backup-created', backupId: 'archive', archiveSha256: 'digest' } };
  assert.match(render(), /这还不是独立位置的副本/); assert.doesNotMatch(render(), /已实际另存/);
  result.localCopy = { label: 'verified.cxb', verified: true };
  assert.match(render(), /已实际另存并校验完整摘要：verified.cxb/);
  assert.doesNotMatch(render(), /type="file"|name="path"|name="archiveSha256"/);
});

test('restore awaiting key and failed reconciliation never show restored data as complete', () => {
  const result = { backupOperation: true, boxId: 'box-1', requestId: 'job', keyReceived: true,
    status: { operationId: 'job', state: 'running', phase: 'awaiting_key', errorCode: null, recoveryRequired: false, result: null } };
  let html = renderDeviceTrust({ snapshot: base(), view: 'backup', result });
  assert.match(html, /只向已批准的目标交付本份备份的数据密钥/);
  assert.match(html, /仍需等待最终核验/); assert.doesNotMatch(html, /业务数据还原已验证完成/);
  result.status = { ...result.status, state: 'failed', phase: 'recovery_required', recoveryRequired: true, errorCode: 'RESTORE_INTERRUPTED' };
  html = renderDeviceTrust({ snapshot: base(), view: 'backup', result });
  assert.match(html, /数据入口继续隔离/); assert.doesNotMatch(html, /业务数据还原已验证完成/);
});

test('unknown errors do not reveal supplied secrets and no stale success is fabricated', async t => {
  const h = await harness(t, base(), { confirmApproval: async () => { throw new Error('private-value'); } });
  let task = await h.submit('prepareApproval', { invitation: 'public' }); await task.promise;
  task = await h.submit('confirm-review', { reviewed: 'on', passphrase: 'local-secret' }); await task.promise;
  assert.match(h.root.innerHTML, /操作未完成/);
  assert.doesNotMatch(h.root.innerHTML, /private-value|local-secret|盒子已确认绑定|immutable-request-digest/);
});

test('document CSP permits only local scripts and styles with no network or frames', async () => {
  const html = await readFile(new URL('../local-ui/device-trust/index.html', import.meta.url), 'utf8');
  for (const policy of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "script-src 'self'"]) assert.ok(html.includes(policy));
  assert.doesNotMatch(html, /unsafe-inline|https?:\/\//);
});

test('transfer review shows actual clearing roots and affected members and requires explicit erase text', async t => {
  const transfer = { ...review('ledger-mutation'), action: 'ownership.transfer-prepare', args: {},
    mutationDigest: 'mutation-digest', effects: { revokedBindings: { count: 4 }, suspendedBindings: { count: 0 },
      invalidatedRequests: { count: 1 }, remainingIndependentManagers: 0, verifiedRecoveryAvailable: false, targetSummaries: [] },
    transferPlan: { scopeManifestDigest: 'scope-digest', resetPlanDigest: 'reset-digest', scope: {
      resourceRoots: ['/var/lib/private-business'], cacheRoots: ['/var/lib/local-backups'], preservedSecurityRoots: ['/var/lib/security-history'],
      affectedPrincipals: 2, affectedBindings: 4, retainedExternalBackups: true } } };
  const h = await harness(t, base(), {
    prepareOwnershipTransfer: async () => transfer,
    confirmSecurityMutation: async input => { h.calls.push(['confirmSecurityMutation', input]); return { state: 'committed', boxId: 'box-1',
      requestId: 'transfer-request', ack: { action: 'ownership.transfer-prepare' }, self: { active: false } }; },
  });
  let task = await h.submit('prepareOwnershipTransfer', { boxId: 'box-1' }); await task.promise;
  for (const text of ['/var/lib/private-business', '/var/lib/local-backups', '受影响成员数', '所有已绑定成员', '独立备份无法撤回', '新的受保护交付秘密']) assert.ok(h.root.innerHTML.includes(text));
  task = await h.submit('confirm-review', { reviewed: 'on', passphrase: 'synthetic', eraseConfirmation: '错误' }); await task.promise;
  assert.equal(h.calls.length, 0);
  task = await h.submit('confirm-review', { reviewed: 'on', passphrase: 'synthetic', eraseConfirmation: '清除本地数据' }); await task.promise;
  assert.deepEqual(h.calls[0], ['confirmSecurityMutation', { reviewHandle: 'opaque-handle', passphrase: 'synthetic' }]);
  assert.match(h.root.innerHTML, /这不表示数据已擦除/);
  assert.match(h.root.innerHTML, /不表示新交付秘密已准备完成/);
});

test('transfer completion view separates archived erasure/redelivery evidence from new owner binding', () => {
  const value = { boxId: 'box-1', requestId: 'transfer-request', transferStatus: { transferId: 'transfer', state: 'frozen', sourceOwnershipEpoch: 1,
    updatedAt: 2000000000, checkpoint: { context: { ownershipEpoch: 1 }, eventDigest: 'event' }, resetEvidenceDigest: null, preparedDeliveryDigest: null } };
  const frozen = renderDeviceTrust({ snapshot: base(), view: 'transfer', result: value });
  assert.match(frozen, /所有权已冻结/); assert.match(frozen, /尚无完整的擦除及新交付就绪证据/);
  value.transferStatus.state = 'redelivery_ready'; value.transferStatus.checkpoint.context.ownershipEpoch = 2;
  const ready = renderDeviceTrust({ snapshot: base(), view: 'transfer', result: value });
  assert.match(ready, /已验证擦除，新的交付材料已就绪/); assert.match(ready, /不表示新主人已完成绑定/);
  assert.match(ready, /独立备份无法撤回/); assert.doesNotMatch(ready, /name="claimSecret"/);
});

test('backup range comes from the signed catalog and the submit forwards only selected profile and target', async t => {
  const h = await harness(t, base(), {
    refreshBackupTargets: async () => ({ boxId: 'box-1', recovery: { version: 1 }, targets: [{ targetId: 'local-managed', maxArchiveBytes: 209715200,
      scopeProfiles: ['semantica-private-v1', 'wanx-personal-v1'], resourceIds: ['clipboard', 'semantica', 'space:personal'] }] }),
    prepareBackupCreate: async input => { h.calls.push(['prepareBackupCreate', input]); return null; },
  });
  await h.click({ view: 'backup' });
  const requested = await h.submit('refreshBackupTargets', { boxId: 'box-1' }); await requested.promise;
  assert.match(h.root.innerHTML, /请选择一种范围/); assert.match(h.root.innerHTML, /个人文件空间与便签/);
  assert.match(h.root.innerHTML, /不包括对话、Agent、授权或外部存储/);
  const selected = await h.submit('prepareBackupCreate', { targetId: 'local-managed', scopeProfile: 'wanx-personal-v1',
    resourceIds: 'someone-else', path: '/arbitrary' }); await selected.promise;
  assert.deepEqual(h.calls[0], ['prepareBackupCreate', { boxId: 'box-1', targetId: 'local-managed', scopeProfile: 'wanx-personal-v1', includeBusinessSecrets: false }]);
});
