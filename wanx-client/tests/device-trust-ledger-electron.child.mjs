// Isolated real Electron test entry. Never imports shell/main or a user profile.
import assert from 'node:assert/strict';
import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createDeviceTrustCoordinator } from '../device-trust/coordinator.mjs';
import { createDeviceTrustWindow } from '../shell/device-trust-window.mjs';
import { createRecoveryFiles } from '../shell/recovery-files.mjs';
import { createBackupFiles } from '../shell/backup-files.mjs';
import { createPinnedTransport } from '../device-trust/pinned-transport.mjs';

let startupStage = 'directory';
async function main() {
const args = Object.fromEntries(process.argv.slice(2).filter(value => value.startsWith('--')).map(value => value.slice(2).split('=')));
assert.match(args.role || '', /^(owner|manager|member)$/);
const root = realpathSync(args['fixture-root']);
assert.match(path.basename(root), /^wanx-ledger-electron-/);
const directory = path.join(root, args.role);
mkdirSync(directory, { mode: 0o700 });
mkdirSync(path.join(directory, 'chromium'), { mode: 0o700 });
startupStage = 'profile';
app.setPath('userData', path.join(directory, 'chromium'));
app.setName(`本地管理隔离验证 ${args.role}`);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
startupStage = 'ready';
await app.whenReady();
let fileChoice = path.join(root, `recovery-${args.role}.json`);
const files = createRecoveryFiles({ dialog: {
  showSaveDialog: async () => ({ canceled: false, filePath: fileChoice }),
  showOpenDialog: async () => ({ canceled: false, filePaths: [fileChoice] }),
} });
let archiveChoice = path.join(root, 'archive-owner.cxb');
const backupFiles = createBackupFiles({ dialog: {
  showSaveDialog: async () => ({ canceled: false, filePath: archiveChoice }),
  showOpenDialog: async () => ({ canceled: false, filePaths: [archiveChoice] }),
} });
startupStage = 'coordinator';
const namespaceRequests = new Map(); let namespaceSequence = 0, lastNetworkError = null;
const actualService = await createDeviceTrustCoordinator({ directory: path.join(directory, 'identity'), files, backupFiles,
  ledgerTransportFactory: descriptor => { const transport = createPinnedTransport({ descriptor, protocolVersion: 2 });
    return { request: async (route, ...args) => { try { return await transport.request(route, ...args); }
      catch (error) { lastNetworkError = `${route}:${error.code}`; throw error; } } }; },
  // Test-only bridge to actual native namespace initialization in the temporary
  // Python fixture. Product uses the separately tested fixed DataAccess hook.
  ensureBackupNamespace: ({ signal, ...identity }) => new Promise((resolve, reject) => {
    signal.throwIfAborted(); const id = ++namespaceSequence;
    const abort = () => { namespaceRequests.delete(id); reject(new Error('FIXTURE_NAMESPACE_ABORTED')); };
    signal.addEventListener('abort', abort, { once: true });
    namespaceRequests.set(id, { resolve: value => { signal.removeEventListener('abort', abort); resolve(value); },
      reject: error => { signal.removeEventListener('abort', abort); reject(error); } });
    process.stdout.write(`TRUST_FIXTURE ${JSON.stringify({ type: 'namespace-request', id, identity })}\n`);
  }),
});
let lastError = null;
const service = new Proxy(actualService, { get(object, name) {
  const value = object[name];
  if (typeof value !== 'function') return value;
  return (...args) => {
    const record = error => { lastError = /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'FIXTURE_SERVICE_ERROR'; throw error; };
    try { const result = value(...args); return result?.catch ? result.catch(record) : result; } catch (error) { return record(error); }
  };
} });
const controller = createDeviceTrustWindow({ BrowserWindow, ipcMain, service });
startupStage = 'window';
await controller.open();
const window = BrowserWindow.getAllWindows()[0];
const js = code => window.webContents.executeJavaScript(code);
const until = `async predicate => { for(let i=0;i<500;i++){ if(predicate()) return; await new Promise(resolve=>setTimeout(resolve,20)); } throw Error('FIXTURE_UI_DEADLINE'); }`;
startupStage = 'document';
await js(`(${until})(()=>Boolean(document.querySelector('form')))`);
const emit = value => process.stdout.write(`TRUST_FIXTURE ${JSON.stringify(value)}\n`);
emit({ type: 'ready', role: args.role });
async function command(input) {
  if (['submit', 'click'].includes(input.method)) lastError = null;
  if (input.method === 'submit') return js(`(async()=>{
    const form=document.querySelector('[data-form='+${JSON.stringify(input.form)}+']');
    if(!form) throw Error('FIXTURE_FORM_MISSING');
    for(const [key,value] of Object.entries(${JSON.stringify(input.values)})) {
      const node=form.elements.namedItem(key); if(!node) throw Error('FIXTURE_FIELD_MISSING');
      if(node.type==='checkbox') node.checked=Boolean(value); else node.value=value;
    }
    form.requestSubmit(); await (${until})(()=>!document.querySelector('.working'));
    return {notice:document.querySelector('p.notice[role=alert]')?.textContent||null};
  })()`).then(value => ({ ...value, errorCode: lastError }));
  if (input.method === 'click') return js(`(async()=>{
    const node=document.querySelector(${JSON.stringify(input.selector)}); if(!node) throw Error('FIXTURE_ELEMENT_MISSING');
    node.click(); await (${until})(()=>!document.querySelector('.working'));
    return {notice:document.querySelector('p.notice[role=alert]')?.textContent||null};
  })()`).then(value => ({ ...value, errorCode: lastError }));
  if (input.method === 'read-public-text') return js(`(()=>{
    const node=document.querySelector(${JSON.stringify(input.selector)});
    if(!node || node.tagName!=='TEXTAREA' || !node.readOnly) throw Error('FIXTURE_PUBLIC_TEXT_MISSING');
    return node.value;
  })()`);
  if (input.method === 'inspect') return js(`({
    deviceCount:document.querySelectorAll('.device-list .device').length,
    passwordEmpty:[...document.querySelectorAll('input[type=password]')].every(node=>node.value===''),
    reviewVisible:Boolean(document.querySelector('.review')),
    notice:document.querySelector('p.notice[role=alert]')?.textContent||null,
    overflow:document.documentElement.scrollWidth>window.innerWidth,
    statusText:[...document.querySelectorAll('[role=status]')].map(node=>node.textContent).join(' '),
    reviewText:document.querySelector('.review')?.textContent||'',
  })`).then(value => ({ ...value, networkError: lastNetworkError }));
  if (input.method === 'snapshot') return service.snapshot();
  if (input.method === 'fresh-self') return js(`window.wanxDeviceTrust.refreshSelfBinding(${JSON.stringify({ boxId: input.boxId })})`);
  if (input.method === 'fresh-transfer') return js(`window.wanxDeviceTrust.refreshOwnershipTransfer(${JSON.stringify({ boxId: input.boxId, requestId: input.requestId })})`);
  if (input.method === 'system-lock') { await controller.invalidate('fixture-system-lock'); return null; }
  if (input.method === 'file-choice') {
    assert.match(input.name, /^recovery-[a-z0-9-]+\.json$/); fileChoice = path.join(root, input.name); return null;
  }
  if (input.method === 'archive-choice') {
    assert.match(input.name, /^archive-[a-z0-9-]+\.cxb$/); archiveChoice = path.join(root, input.name); return null;
  }
  if (input.method === 'screenshot') {
    assert.match(input.name, /^[a-z0-9-]+\.png$/);
    const { writeFile } = await import('node:fs/promises');
    // Capture only after form reset; material private bytes never enter the DOM.
    const safe = await command({ method: 'inspect' }); assert.equal(safe.passwordEmpty, true);
    const filename = path.join(root, input.name);
    await writeFile(filename, (await window.webContents.capturePage()).toPNG()); return filename;
  }
  if (input.method === 'close') { await controller.dispose(); service.close(); files.close(); await backupFiles.close(); return 'closed'; }
  throw new Error('FIXTURE_COMMAND_INVALID');
}
const lines = createInterface({ input: process.stdin });
let pending = Promise.resolve();
lines.on('line', line => {
  const reply = JSON.parse(line);
  if (reply.method === 'namespace-response') {
    const request = namespaceRequests.get(reply.id); namespaceRequests.delete(reply.id);
    if (reply.ok) request?.resolve(reply.identity); else request?.reject(new Error('FIXTURE_NAMESPACE_REJECTED'));
    return;
  }
  pending = pending.then(async () => {
    let input;
    try {
      input = JSON.parse(line); const value = await command(input); emit({ id: input.id, ok: true, value });
      if (input.method === 'close') app.exit(0);
    } catch (error) {
      // Never dump DOM text, form contents, file bytes, proofs or passphrases.
      emit({ id: input?.id, ok: false, code: /^[A-Z0-9_]+$/.test(error.code || error.message || '') ? (error.code || error.message) : 'FIXTURE_OPERATION_FAILED' });
    }
  });
});
lines.on('close', () => { void pending.finally(async () => { await controller.dispose().catch(() => {}); service.close(); files.close(); await backupFiles.close(); app.exit(0); }); });
}
// Electron resolves readiness after evaluating its entry module. Keeping the
// readiness await inside this task avoids blocking that module evaluation.
void main().catch(error => {
  process.stdout.write(`TRUST_FIXTURE ${JSON.stringify({ type: 'startup-error', code:
    /^[A-Z0-9_]+$/.test(error.code || error.message || '') ? (error.code || error.message) : `FIXTURE_STARTUP_${startupStage.toUpperCase()}_${error.name || 'FAILED'}` })}\n`, () => app.exit(1));
});
