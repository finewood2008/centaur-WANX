import { createDeviceSetupTransport } from './deviceSetupTransport';
import { createBluetoothAvailability } from './bluetooth-availability.mjs';

const bluetoothAvailability = createBluetoothAvailability(navigator.bluetooth,
  window.wanxDiscovery?.bluetoothState ? () => window.wanxDiscovery!.bluetoothState() : undefined);
window.wanxBluetooth = bluetoothAvailability;
void bluetoothAvailability.refresh();
window.addEventListener?.('focus', () => { void bluetoothAvailability.refresh(); });

if (window.wanxSetupTransport && navigator.bluetooth) {
  const transport = createDeviceSetupTransport({
    bridge: window.wanxSetupTransport,
    bluetooth: navigator.bluetooth,
    selectionTimeoutMs: window.wanxSetupTransport.scanTimeoutMs,
  });
  window.wanxDeviceSetupTransport = {
    requestDeviceFromUserGesture() {
      // Call the browser API before yielding: scanning requires this click's
      // transient activation. Permission failures update the preflight guidance.
      return transport.requestDeviceFromUserGesture().catch(error => {
        bluetoothAvailability.reportError(error);
        throw error;
      });
    },
    cancelSelection: () => transport.cancelSelection(),
    dispose: () => transport.dispose(),
  };
}
