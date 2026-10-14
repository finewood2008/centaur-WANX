import { createProvisioningHost } from './provisioning-host.cjs';
import { createClaimResumeStore } from './claim-resume-store.cjs';
import { createPairingConsumer } from '../account/pairing.mjs';
import { installElectronBluetoothPicker } from '@nexusaos/device-discovery-electron/main';
import { readFile } from 'node:fs/promises';

// Composition seam: the existing BLE coordinator borrows the P2P account identity.
export async function createSetupRuntime({
  control, controlURL, ipcMain, account, client, safeStorage, userData, consumerBaseUrl,
  advertisementNames,
  makeHost = createProvisioningHost, makeStore = createClaimResumeStore,
  installPicker = installElectronBluetoothPicker,
  onError = () => {},
}) {
  const consumer = createPairingConsumer(account);
  let host, disposePicker, unsubscribeHost, unsubscribeAccount;
  let disposed = false;
  let completedFlow;
  const ready = () => {
    if (!control.isDestroyed()) control.webContents.send('wanx:setup:ready');
  };
  try {
    host = await makeHost({
      webContents: control.webContents, ipcMain, documentUrl: controlURL, consumer,
      resumeStore: makeStore({ directory: userData, safeStorage, consumerBaseUrl }),
      ...JSON.parse(await readFile(new URL('./provisioning-trust.json', import.meta.url), 'utf8')),
    });
    disposePicker = installPicker({
      webContents: control.webContents, ipcMain, documentUrl: controlURL,
      advertisementNames,
      scanTimeoutMs: process.platform === 'win32' ? 60000 : 12000,
      clock: { monotonicMs: () => performance.now() },
    });
    unsubscribeHost = host.subscribe((state) => {
      if (!disposed && state.state === 'completed' && completedFlow !== state.flowId) {
        completedFlow = state.flowId;
        void client.refreshDevices().catch(onError);
      }
    });
    let identity = account.getIdentity();
    unsubscribeAccount = account.subscribe(() => {
      const next = account.getIdentity();
      if (identity && (!next || identity.accountId !== next.accountId || identity.clientId !== next.clientId)) {
        completedFlow = undefined;
        void host.reset().catch(onError);
      }
      identity = next;
    });
    control.webContents.on('did-finish-load', ready);
    ready();
    return {
      async dispose() {
        if (disposed) return;
        disposed = true;
        control.webContents.removeListener('did-finish-load', ready);
        unsubscribeAccount?.();
        unsubscribeHost?.();
        disposePicker?.();
        await host.dispose();
        consumer.dispose();
      },
    };
  } catch (error) {
    unsubscribeAccount?.();
    unsubscribeHost?.();
    disposePicker?.();
    await host?.dispose();
    consumer.dispose();
    throw error;
  }
}
