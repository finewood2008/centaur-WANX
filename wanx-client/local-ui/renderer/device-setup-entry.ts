import { createDeviceSetupTransport } from './deviceSetupTransport';

if (window.wanxSetupTransport && navigator.bluetooth) {
  const transport = createDeviceSetupTransport({
    bridge: window.wanxSetupTransport,
    bluetooth: navigator.bluetooth,
  });
  window.wanxDeviceSetupTransport = transport;
}
