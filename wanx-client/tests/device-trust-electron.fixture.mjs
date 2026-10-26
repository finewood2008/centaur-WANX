// Manual isolated Chromium seam. Never imports the normal desktop entry or a
// real profile/transport. Run with node_modules/.bin/electron, not node --test.
import assert from 'node:assert/strict';
import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdtempSync } from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeviceTrustWindow } from '../shell/device-trust-window.mjs';

const directory = mkdtempSync(path.join(os.tmpdir(), 'wanx-trust-ui-fixture-'));
app.setPath('userData', path.join(directory, 'profile'));
app.setName('万象本地权限隔离验证');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const handle = Buffer.alloc(32, 7).toString('base64url');
const requestId = Buffer.alloc(32, 8).toString('base64url');
const calls = [], consoleErrors = [];
let profile = null, window, controller, stage = 'startup';
const review = kind => ({ reviewHandle: handle, kind, boxId: 'box:fixture', boxKeyThumbprint: 'Test-Box-Public-Fingerprint-Only', principalId: 'local-principal-fixture', clientId: kind === 'approval' ? 'new-device-fixture' : 'client-fixture', role: kind === 'first-root' ? 'root' : 'use', grants: [{ resourceId: 'space:personal', actions: ['read', 'write'] }], expiresAt: Math.floor(Date.now() / 1000) + 300, grantExpiresAt: null, accessKeyThumbprint: 'Test-Device-Public-Fingerprint-Only', ownershipEpoch: 1, rosterVersion: 3, requestDigest: 'Test-Immutable-Request-Digest-Only', ...(kind === 'approval' ? { approverBindingId: 'manager-binding-fixture' } : {}) });
const service = {
  snapshot: async () => ({ profile, boxes: profile && !profile.locked ? [{ boxId: 'box:fixture', role: 'root' }] : [] }),
  createProfile: async () => { calls.push('createProfile'); profile = { locked: false, principalId: 'local-principal-fixture', clientId: 'client-fixture', keyProtection: 'software-passphrase-v1' }; },
  unlock: async () => { calls.push('unlock'); profile.locked = false; },
  lock: reason => { calls.push(`lock:${reason}`); if (profile) profile.locked = true; },
  prepareFirstRoot: async () => { calls.push('prepareFirstRoot'); return review('first-root'); },
  confirmFirstRoot: async input => { assert.equal(input.reviewHandle, handle); calls.push('confirmFirstRoot'); return { boxId: 'box:fixture', requestId, state: 'approved', ack: { requestId, bindingId: 'manager-binding-fixture', rosterVersion: 1 } }; },
  prepareApproval: async () => { calls.push('prepareApproval'); return review('approval'); },
  confirmApproval: async input => { assert.equal(input.reviewHandle, handle); calls.push('confirmApproval'); return { boxId: 'box:fixture', requestId, state: 'approved', ack: { requestId, bindingId: 'device-binding-fixture', rosterVersion: 4 } }; },
  refreshDevices: async ({ boxId }) => ({ boxId, devices: [{ bindingId: 'manager-binding-fixture', clientId: 'client-fixture', role: 'root', status: 'active', accessKeyThumbprint: 'Test-Manager-Public-Fingerprint-Only' }], recoveryConfigured: false }),
  exportJoinInfo: async () => ({ joinInfo: '{"fixture":"public-join-info"}' }),
};
async function verify() {
try {
  await app.whenReady();
  controller = createDeviceTrustWindow({ BrowserWindow, ipcMain, service });
  await controller.open();
  stage = 'created-window';
  window = BrowserWindow.getAllWindows()[0];
  window.webContents.on('console-message', event => { if (event.level === 'error') consoleErrors.push(event.message); });
  const js = code => window.webContents.executeJavaScript(code);
  await js(`window.until = async predicate => { for (let i=0; i<100; i++) { if(predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error('fixture timeout'); }; void 0;`);
  const waitFor = selector => js(`until(() => !!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector('[aria-busy="true"]'))`);
  const submit = (name, values) => js(`(() => { const form=document.querySelector('[data-form="${name}"]'); for(const [key,value] of Object.entries(${JSON.stringify(values)})) { const node=form.elements.namedItem(key); if(node.type==='checkbox') node.checked=Boolean(value); else node.value=value; } form.requestSubmit(); })()`);
  await waitFor('[data-form="createProfile"]');
  stage = 'create-profile';
  await submit('createProfile', { passphrase: 'fixture-only-password', repeatPassphrase: 'fixture-only-password' });
  await waitFor('[data-view="first-root"]:not(:disabled)');
  stage = 'prepare-first-root';
  await js(`document.querySelector('[data-view="first-root"]').click()`);
  await waitFor('[data-form="prepareFirstRoot"]');
  await submit('prepareFirstRoot', { deliveryPacket: '{"fixture":"not-a-real-delivery-secret"}' });
  await waitFor('[data-form="confirm-review"]');
  assert.equal(await js(`document.body.textContent.includes('Test-Box-Public-Fingerprint-Only')`), true);
  await writeFile(path.join(directory, 'first-root.png'), (await window.webContents.capturePage()).toPNG());
  stage = 'confirm-first-root';
  await submit('confirm-review', { passphrase: 'fixture-only-password', reviewed: true });
  await js(`until(() => document.body.textContent.includes('盒子已确认绑定'))`);
  stage = 'devices';
  await js(`document.querySelector('[data-view="devices"]').click()`);
  await waitFor('[data-form="refreshDevices"]');
  await submit('refreshDevices', { boxId: 'box:fixture' });
  await js(`until(() => document.body.textContent.includes('manager-binding-fixture'))`);
  await writeFile(path.join(directory, 'devices.png'), (await window.webContents.capturePage()).toPNG());
  stage = 'approval';
  await js(`document.querySelector('[data-view="approval"]').click()`);
  await waitFor('[data-form="prepareApproval"]');
  await submit('prepareApproval', { invitation: '{"fixture":"public-invitation"}' });
  await waitFor('[data-form="confirm-review"]');
  await writeFile(path.join(directory, 'approval.png'), (await window.webContents.capturePage()).toPNG());
  await js(`document.querySelector('[data-form="confirm-review"]').scrollIntoView({block:'end'})`);
  assert.equal(await js(`document.documentElement.scrollWidth <= window.innerWidth`), true);
  await writeFile(path.join(directory, 'approval-confirm.png'), (await window.webContents.capturePage()).toPNG());
  stage = 'lock';
  await js(`document.querySelector('[name="passphrase"]').value='fixture-password-to-clear'`);
  await controller.invalidate('system-suspended');
  await waitFor('[data-form="unlock"]');
  assert.equal(await js(`document.querySelector('[name="passphrase"]').value`), '');
  assert.equal(await js(`document.body.textContent.includes('Test-Immutable-Request-Digest-Only')`), false);
  await submit('unlock', { passphrase: 'fixture-only-password' });
  await waitFor('[data-view="overview"]:not(:disabled)');
  stage = 'reload';
  window.webContents.reload();
  await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  assert.equal(profile.locked, true);
  stage = 'foreign-window';
  // A different renderer loading the exact same local document has no authority.
  const foreign = new BrowserWindow({ show: false, webPreferences: { preload: fileURLToPath(new URL('../local-ui/device-trust-preload.cjs', import.meta.url)), nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'wanx-trust-fixture-foreign' } });
  await foreign.loadURL(window.webContents.getURL());
  const foreignCode = await foreign.webContents.executeJavaScript(`window.wanxDeviceTrust.snapshot().then(()=>'unexpected-success',error=>error.code || error.message)`);
  assert.equal(foreignCode, 'LOCAL_TRUST_UNTRUSTED_SENDER');
  foreign.destroy();
  assert.deepEqual(consoleErrors, []);
  await controller.dispose();
  await rm(path.join(directory, 'profile'), { recursive: true, force: true });
  const result = JSON.stringify({ ok: true, screenshots: ['first-root.png', 'devices.png', 'approval.png', 'approval-confirm.png'].map(name => path.join(directory, name)), calls, foreignCode });
  await writeFile(path.join(directory, 'result.json'), result);
  process.stdout.write(`${result}\n`, () => app.exit(0));
} catch (error) {
  console.error(JSON.stringify({ stage, calls, consoleErrors, body: window && !window.isDestroyed() ? await window.webContents.executeJavaScript('document.body.innerText').catch(() => '') : '' }));
  console.error(error);
  await controller?.dispose().catch(() => {});
  await rm(path.join(directory, 'profile'), { recursive: true, force: true }).catch(() => {});
  app.exit(1);
}
}
void verify();
