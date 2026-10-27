// Actual isolated Electron window/preload/UI. Synthetic business service and
// picker selection; cryptography and Python interoperability have separate tests.
import assert from 'node:assert/strict';
import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDeviceTrustWindow } from '../shell/device-trust-window.mjs';
import { createOfflineWifiTransport } from '../shell/offline-wifi-transport.mjs';

const directory = mkdtempSync(path.join(os.tmpdir(), 'offline-wifi-electron-'));
const evidence = process.env.OFFLINE_WIFI_EVIDENCE || directory;
mkdirSync(evidence, { recursive: true });
app.setPath('userData', path.join(directory, 'profile')); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const errors = [], calls = [], handle = Buffer.alloc(32, 2).toString('base64url');
let profile = { locked: false, principalId: 'test-principal', clientId: 'test-client' }, block, release, controller, window;
const service = {
  snapshot: () => ({ profile, boxes: [{ boxId: 'box:offline-test', role: 'manage' }] }),
  lock: () => { profile = { ...profile, locked: true }; }, unlock: () => { profile = { ...profile, locked: false }; },
  beginOfflineWifi: async input => { calls.push('begin'); assert.equal(input.boxId, 'box:offline-test'); return { boxId: input.boxId, state: 'awaitingWifi' }; },
  prepareOfflineWifi: async input => { calls.push('prepare'); assert.equal(input.password, 'synthetic-wifi-secret');
    return { kind: 'offline-wifi', reviewHandle: handle, boxId: 'box:offline-test', boxKeyThumbprint: 'pinned-box-fingerprint',
      bindingId: 'local-binding', ownershipEpoch: 1, authorizationVersion: 4, expiresAt: Math.floor(Date.now() / 1000) + 120,
      ssid: input.ssid, security: input.security, hidden: input.hidden, grants: [{ resourceId: 'network:wifi', actions: ['write'] }] }; },
  confirmOfflineWifi: async input => { calls.push('confirm'); assert.equal(input.reviewHandle, handle); assert.equal(input.passphrase, 'synthetic-local-passphrase');
    await block; return { boxId: 'box:offline-test', state: 'completed' }; },
  cancelOfflineWifi: () => { calls.push('cancel'); },
};
async function verify() { try {
  await app.whenReady();
  app.on('browser-window-created', (_event, created) => created.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); }));
  const transport = createOfflineWifiTransport({ ipcMain });
  controller = createDeviceTrustWindow({ BrowserWindow, ipcMain, service, wifiTransport: transport });
  await controller.open({ view: 'wifi' }); window = BrowserWindow.getAllWindows()[0];
  const js = value => window.webContents.executeJavaScript(value);
  const paint = () => js(`window.scrollTo(0,0); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await js(`window.until = async predicate => { for (let i=0;i<150;i++) { if(predicate()) return; await new Promise(resolve=>setTimeout(resolve,20)); } throw Error('UI_TIMEOUT'); }; void 0;`);
  const wait = selector => js(`until(() => !!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector('[aria-busy="true"]'))`);
  const submit = (name, values) => js(`(() => { const form=document.querySelector('[data-form="${name}"]'); for (const [key,value] of Object.entries(${JSON.stringify(values)})) { const node=form.elements.namedItem(key); if(node.type==='checkbox') node.checked=Boolean(value); else node.value=value; } form.requestSubmit(); })()`);
  await wait('[data-form="beginOfflineWifi"]');
  assert.equal(await js(`typeof window.wanxDeviceTrust.sign`), 'undefined');
  assert.equal(await js(`document.body.textContent.includes('无需云端登录')`), true);
  await js(`Object.assign(window.wanxDeviceSetupTransport, { requestDeviceFromUserGesture: async () => ({ candidateId:'candidate',transport:'ble-gatt',transportHandle:'handle',selectionLeaseId:'lease',advertisedName:'test-box',rssi:null,firstSeenMonotonicMs:1,lastSeenMonotonicMs:1 }),cancelSelection:async()=>{} }); void 0;`);
  const prepare = async () => {
    await submit('beginOfflineWifi', { boxId: 'box:offline-test' }); await wait('[data-form="prepareOfflineWifi"]');
    await submit('prepareOfflineWifi', { ssid: '测试路由器', security: 'wpa_personal', hidden: true, password: 'synthetic-wifi-secret' });
    await wait('[data-form="confirm-review"]');
  };
  await prepare();
  assert.equal(await js(`document.body.textContent.includes('pinned-box-fingerprint')`), true);
  assert.equal(await js(`document.body.innerHTML.includes('synthetic-wifi-secret')`), false);
  assert.equal(await js(`document.documentElement.scrollWidth <= window.innerWidth`), true);
  await paint(); await writeFile(path.join(evidence, 'offline-wifi-review.png'), (await window.webContents.capturePage()).toPNG());
  await submit('confirm-review', { passphrase: 'synthetic-local-passphrase', reviewed: true });
  await js(`until(() => document.body.textContent.includes('盒子已确认本次 Wi-Fi 配置完成'))`);
  await js(`document.querySelector('[data-action="cancel-wifi"]').click()`); await wait('[data-form="beginOfflineWifi"]');
  await prepare(); block = new Promise(resolve => { release = resolve; });
  await submit('confirm-review', { passphrase: 'synthetic-local-passphrase', reviewed: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  await controller.invalidate('suspend'); release(); await wait('[data-form="unlock"]');
  assert.equal(await js(`document.querySelector('[name="passphrase"]').value`), '');
  assert.equal(await js(`document.body.textContent.includes('盒子已确认本次 Wi-Fi 配置完成')`), false);
  assert.equal(await js(`document.body.textContent.includes('仅修改本次 Wi-Fi')`), false);
  await paint(); await writeFile(path.join(evidence, 'offline-wifi-locked.png'), (await window.webContents.capturePage()).toPNG());
  assert.deepEqual(errors, []);
  const result = { ok: true, boundary: 'Actual isolated Electron UI/IPC; synthetic selection/service; no radio or cloud', calls,
    screenshotFiles: ['offline-wifi-review.png', 'offline-wifi-locked.png'] };
  await controller.dispose(); await rm(directory, { recursive: true, force: true });
  await writeFile(path.join(evidence, 'electron-result.json'), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result) + '\n', () => app.exit(0));
} catch (error) {
  console.error(error); console.error(JSON.stringify({ calls, errors,
    view: window && !window.isDestroyed() ? await window.webContents.executeJavaScript('document.body.innerText').catch(() => 'unavailable') : 'no-window' }));
  await controller?.dispose().catch(() => {}); await rm(directory, { recursive: true, force: true }); app.exit(1);
} }
void verify();
