import { createDeviceSetupTransport } from './deviceSetupTransport';

if (window.wanxSetupTransport && navigator.bluetooth) {
  const transport = createDeviceSetupTransport({
    bridge: window.wanxSetupTransport,
    bluetooth: navigator.bluetooth,
    selectionTimeoutMs: window.wanxSetupTransport.scanTimeoutMs,
  });
  window.wanxDeviceSetupTransport = transport;
}
