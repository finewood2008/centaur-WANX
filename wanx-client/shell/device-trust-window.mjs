import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isControlSender } from './security.mjs';
import { LEDGER_CAPABILITIES } from '../device-trust/ledger-contract.mjs';
import { validateWifiCandidate } from './offline-wifi-transport.mjs';
import { installElectronBluetoothPicker } from '@nexusaos/device-discovery-electron/main';

const documentURL = new URL('../local-ui/device-trust/index.html', import.meta.url).href;
const preloadPath = fileURLToPath(new URL('../local-ui/device-trust-preload.cjs', import.meta.url));
const views = new Set(['overview', 'identity', 'first-root', 'join', 'approval', 'devices', 'security', 'enrollment', 'recovery', 'backup', 'transfer', 'wifi']);
const enrollment = { boxId: 'token', targetInfo: 'ledger-import', capabilities: 'optional-capabilities',
  grants: 'grants', delegableGrants: 'delegable-grants', expiresAt: 'expiry', delegationExpiresAt: 'expiry' };
const methods = {
  snapshot: {}, createProfile: { passphrase: 'secret' }, unlock: { passphrase: 'secret' }, lock: {},
  prepareFirstRoot: { deliveryPacket: 'packet' },
  confirmFirstRoot: { reviewHandle: 'digest', passphrase: 'secret' },
  exportJoinInfo: { boxId: 'token' }, prepareJoin: { joinInfo: 'import' },
  submitJoin: { reviewHandle: 'digest' }, prepareApproval: { invitation: 'import' },
  confirmApproval: { reviewHandle: 'digest', passphrase: 'secret' },
  refreshRequest: { boxId: 'token', requestId: 'digest' },
  cancelRequest: { boxId: 'token', requestId: 'digest' }, refreshDevices: { boxId: 'token' },
  refreshSecurityState: { boxId: 'token' }, refreshSelfBinding: { boxId: 'token' }, refreshMembers: { boxId: 'token' },
  prepareActivatePolicy: { boxId: 'token', capabilities: 'capabilities' },
  prepareDeviceRevocation: { boxId: 'token', bindingId: 'token', mode: 'revoke-mode' },
  prepareDescendantReview: { boxId: 'token', bindingIds: 'tokens' },
  prepareMemberRevocation: { boxId: 'token', principalId: 'token' },
  confirmSecurityMutation: { reviewHandle: 'digest', passphrase: 'secret' },
  refreshSecurityMutation: { boxId: 'token', requestId: 'digest' },
  refreshDataEffect: { boxId: 'token', requestId: 'digest' },
  exportTargetInfo: {}, prepareManagerEnrollment: enrollment, prepareMemberInvitation: enrollment,
  exportTargetReview: { reviewHandle: 'digest' }, importTargetProofs: { reviewHandle: 'digest', targetProofs: 'ledger-import' },
  prepareTargetApproval: { reviewHandoff: 'ledger-import' }, confirmTargetApproval: { reviewHandle: 'digest', passphrase: 'secret' },
  exportSecurityReceipt: { boxId: 'token', requestId: 'digest' },
  resumeTargetApproval: { boxId: 'token', requestId: 'digest' },
  acceptEnrollmentReceipt: { boxId: 'token', requestId: 'digest', receipt: 'proof' },
  beginRecoveryConfiguration: { boxId: 'token' }, exportRecoveryMaterial: { materialHandle: 'digest' },
  reimportRecoveryMaterial: { materialHandle: 'digest' }, prepareRecoveryConfiguration: { materialHandle: 'digest' },
  importIdentityRecovery: {}, beginIdentityRecovery: { recoveryHandle: 'digest' },
  prepareIdentityRecovery: { materialHandle: 'digest' }, confirmIdentityRecovery: { reviewHandle: 'digest', passphrase: 'secret' },
  refreshBackupTargets: { boxId: 'token' }, prepareBackupCreate: { boxId: 'token', targetId: 'token', scopeProfile: 'backup-profile', includeBusinessSecrets: 'boolean' },
  importBackupSource: { boxId: 'token' }, prepareBackupRestore: { sourceHandle: 'digest' },
  refreshBackupOperation: { boxId: 'token', requestId: 'digest' }, provideRestoreKey: { boxId: 'token', requestId: 'digest' },
  saveBackupArchive: { boxId: 'token', requestId: 'digest' },
  prepareOwnershipTransfer: { boxId: 'token' },
  refreshOwnershipTransfer: { boxId: 'token', requestId: 'digest' },
  beginOfflineWifi: { boxId: 'token', selected: 'wifi-candidate' }, scanOfflineWifi: {},
  prepareOfflineWifi: { ssid: 'wifi-ssid', security: 'wifi-security', hidden: 'boolean', password: 'wifi-password' },
  confirmOfflineWifi: { reviewHandle: 'digest', passphrase: 'secret' }, cancelOfflineWifi: {},
  prepareWifiAuthorization: { boxId: 'token', bindingId: 'token', expiresAt: 'expiry', delegable: 'boolean' },
  prepareWifiRevocation: { boxId: 'token', bindingId: 'token' },
};
const failure = code => Object.assign(new Error(code), { code });
function errorCode(error) {
  const value = error?.code || error?.message;
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(value)
    ? value : 'LOCAL_TRUST_OPERATION_FAILED';
}
function record(input) {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Reflect.ownKeys(input).some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value');
    })) throw failure('LOCAL_TRUST_INVALID_INPUT');
  return input;
}
function validate(input, schema) {
  input = record(input);
  const keys = Object.keys(schema);
  if (Object.keys(input).length !== keys.length || Object.keys(input).some(key => !Object.hasOwn(schema, key)))
    throw failure('LOCAL_TRUST_INVALID_INPUT');
  for (const key of keys) {
    const value = input[key], kind = schema[key];
    if (kind === 'wifi-candidate') { validateWifiCandidate(value); continue; }
    if (kind === 'wifi-security') { if (!['open', 'wpa_personal'].includes(value)) throw failure('LOCAL_TRUST_INVALID_INPUT'); continue; }
    if (kind === 'wifi-ssid' || kind === 'wifi-password') {
      if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value) ||
        Buffer.byteLength(value, 'utf8') > (kind === 'wifi-ssid' ? 32 : 64) || (kind === 'wifi-ssid' && !value.length)) throw failure('LOCAL_TRUST_INVALID_INPUT');
      continue;
    }
    if (kind === 'boolean') { if (typeof value !== 'boolean') throw failure('LOCAL_TRUST_INVALID_INPUT'); continue; }
    if (kind === 'backup-profile') { if (!['semantica-private-v1', 'wanx-personal-v1'].includes(value)) throw failure('LOCAL_TRUST_INVALID_INPUT'); continue; }
    if (kind === 'tokens' || kind === 'capabilities' || kind === 'optional-capabilities') {
      if (!Array.isArray(value) || value.length < (kind === 'optional-capabilities' ? 0 : 1) || value.length > (kind === 'tokens' ? 16 : 10)
        || value.some((item, i) => typeof item !== 'string' || (i > 0 && item <= value[i - 1])
          || (kind === 'tokens' ? !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item) : !LEDGER_CAPABILITIES.includes(item))))
        throw failure('LOCAL_TRUST_INVALID_INPUT');
      continue;
    }
    if (kind === 'grants' || kind === 'delegable-grants') {
      if (!Array.isArray(value) || value.length < (kind === 'grants' ? 1 : 0) || value.length > 16
        || value.some((grant, i) => !grant || typeof grant !== 'object' || Array.isArray(grant)
          || Object.keys(grant).length !== 2 || !Object.hasOwn(grant, 'resourceId') || !Object.hasOwn(grant, 'actions')
          || typeof grant.resourceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(grant.resourceId)
          || (i > 0 && grant.resourceId <= value[i - 1].resourceId) || !Array.isArray(grant.actions)
          || grant.actions.length < 1 || grant.actions.length > 3 || grant.actions.some((action, j) =>
            !['execute', 'read', 'write'].includes(action) || (j > 0 && action <= grant.actions[j - 1]))))
        throw failure('LOCAL_TRUST_INVALID_INPUT');
      continue;
    }
    if (kind === 'expiry') {
      if (value !== null && (!Number.isSafeInteger(value) || value < 1)) throw failure('LOCAL_TRUST_INVALID_INPUT');
      continue;
    }
    if (kind === 'revoke-mode') {
      if (!['normal', 'emergency-lock'].includes(value)) throw failure('LOCAL_TRUST_INVALID_INPUT');
      continue;
    }
    const maximum = kind === 'packet' ? 8192 : kind === 'import' ? 32768 : kind === 'ledger-import' ? 65536 : kind === 'proof' ? 16384 : kind === 'secret' ? 1024 : 160;
    if (typeof value !== 'string' || !value.length || Buffer.byteLength(value, 'utf8') > maximum ||
        (kind === 'token' && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) ||
        (kind === 'digest' && (!/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, 'base64url').toString('base64url') !== value)) ||
        (kind === 'secret' && /[\0\r\n]/.test(value))) throw failure('LOCAL_TRUST_INVALID_INPUT');
  }
  return Object.fromEntries(keys.map(key => [key, input[key]]));
}

// All cryptography, trust decisions and transport belong to the main-owned service.
// This adapter only accepts fixed business actions from this one local document.
export function createDeviceTrustWindow({ BrowserWindow, ipcMain, service, parentWindow, onError = () => {}, wifiTransport,
  installPicker = installElectronBluetoothPicker }) {
  let window, context = { view: 'overview' }, generation = 0, disposed = false, active = false;
  let lockPending = Promise.resolve(), openPending = Promise.resolve(), loadPending;
  const registrations = [];
  let disposePicker;
  const ensurePicker = () => {
    if (wifiTransport && !disposePicker && window && !window.isDestroyed()) disposePicker = installPicker({
      webContents: window.webContents, ipcMain, documentUrl: documentURL, scanTimeoutMs: 30000,
      clock: { monotonicMs: () => performance.now() },
    });
  };
  function invalidate(reason) {
    generation++;
    active = false;
    wifiTransport?.invalidate(); disposePicker?.(); disposePicker = undefined;
    // Invoke synchronously so the service invalidates signing intents before an
    // already-running asynchronous confirmation can resume.
    try {
      lockPending = Promise.resolve(service.lock(reason)).catch(error => {
        onError(failure(errorCode(error)));
        throw failure('LOCAL_TRUST_LOCK_FAILED');
      });
    } catch (error) {
      onError(failure(errorCode(error)));
      lockPending = Promise.reject(failure('LOCAL_TRUST_LOCK_FAILED'));
    }
    void lockPending.catch(() => {});
    if (window && !window.isDestroyed()) {
      try { window.webContents.send('wanx:device-trust:changed'); } catch { /* Crashed renderer has no state to clear. */ }
    }
    return lockPending;
  }
  const trusted = event => !disposed && isControlSender(event, window, documentURL);
  for (const [method, schema] of Object.entries(methods)) {
    const channel = `wanx:device-trust:${method}`;
    ipcMain.handle(channel, async (event, rawInput) => {
      try {
        if (!trusted(event)) throw failure('LOCAL_TRUST_UNTRUSTED_SENDER');
        const input = validate(rawInput, schema);
        if (method === 'lock') {
          await invalidate('manual');
          return { ok: true, value: null };
        }
        const current = generation;
        await lockPending;
        if (current !== generation || !trusted(event)) throw failure('LOCAL_TRUST_CONTEXT_CHANGED');
        const read = method === 'snapshot';
        if (!read && active) throw failure('LOCAL_TRUST_BUSY');
        if (!read) active = true;
        try {
          const value = await service[method](input);
          if (current !== generation || !trusted(event)) throw failure('LOCAL_TRUST_CONTEXT_CHANGED');
          if (['unlock', 'createProfile'].includes(method)) ensurePicker();
          return { ok: true, value: read ? { ...value, window: { ...context } } : value };
        } finally {
          if (!read && current === generation) active = false;
        }
      } catch (error) {
        return { ok: false, code: errorCode(error) };
      }
    });
    registrations.push(channel);
  }

  async function openWindow(input = {}) {
      input = record(input);
      if (disposed) throw failure('LOCAL_TRUST_WINDOW_CLOSED');
      if (Object.keys(input).some(key => !['view', 'boxId'].includes(key)) ||
          (input.view !== undefined && !views.has(input.view))) throw failure('LOCAL_TRUST_INVALID_INPUT');
      if (input.boxId !== undefined) validate({ boxId: input.boxId }, { boxId: 'token' });
      const next = { view: input.view || 'overview', ...(input.boxId ? { boxId: input.boxId } : {}) };
      if (window && !window.isDestroyed()) {
        if (JSON.stringify(context) !== JSON.stringify(next)) {
          await invalidate('window-context-changed');
          context = next;
          window.webContents.send('wanx:device-trust:changed');
        }
        await loadPending;
        if (window && !window.isDestroyed()) { window.show(); window.focus(); }
        return;
      }
      await lockPending;
      if (disposed) throw failure('LOCAL_TRUST_WINDOW_CLOSED');
      context = next;
      const created = new BrowserWindow({
        width: 900, height: 760, minWidth: 640, minHeight: 560, show: false,
        title: '本地身份与设备权限', backgroundColor: '#f6f7fb',
        ...(parentWindow && !parentWindow.isDestroyed() ? { parent: parentWindow } : {}),
        webPreferences: { preload: preloadPath, nodeIntegration: false, contextIsolation: true,
          sandbox: true, webSecurity: true, devTools: false,
          partition: `wanx-device-trust-${randomUUID()}` },
      });
      window = created;
      const contents = created.webContents;
      wifiTransport?.attach(contents, documentURL);
      let loaded = false, closedWithLock = false;
      const allowedFiles = new Set(['index.html', 'view.mjs', 'styles.css'].map(name => new URL(`../local-ui/device-trust/${name}`, import.meta.url).href));
      allowedFiles.add(new URL('../local-ui/renderer/device-setup.bundle.js', import.meta.url).href);
      const bluetoothPermission = (source, permission) => Boolean(wifiTransport && source === contents && permission === 'bluetooth' &&
        contents.mainFrame?.url === documentURL && service.snapshot()?.profile?.locked === false);
      contents.session.setPermissionRequestHandler((source, permission, callback) => callback(bluetoothPermission(source, permission)));
      contents.session.setPermissionCheckHandler(bluetoothPermission);
      contents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowedFiles.has(details.url) }));
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
        contents.on(name, event => { event.preventDefault(); void invalidate('navigation'); });
      }
      contents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
        if (loaded && isMainFrame !== false) void invalidate('navigation');
      });
      contents.on('render-process-gone', () => { void invalidate('renderer-crashed'); });
      created.on('close', () => { closedWithLock = true; void invalidate('window-closed'); });
      created.on('closed', () => {
        wifiTransport?.detach(contents);
        if (window === created) {
          if (!closedWithLock && !disposed) void invalidate('window-closed');
          window = undefined;
        }
      });
      loadPending = created.loadURL(documentURL);
      try { await loadPending; }
      catch (error) { void invalidate('load-failed'); created.destroy(); throw failure(errorCode(error)); }
      if (disposed || created.isDestroyed()) return;
      loaded = true;
      ensurePicker();
      created.show();
      created.focus();
  }
  return {
    open(input = {}) {
      const pending = openPending.catch(() => {}).then(() => openWindow(input));
      openPending = pending;
      return pending;
    },
    invalidate,
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const channel of registrations) ipcMain.removeHandler(channel);
      const pending = invalidate('disposed');
      if (window && !window.isDestroyed()) window.destroy();
      window = undefined;
      await pending;
      wifiTransport?.dispose();
    },
  };
}
