// Lock immediately, before shutdown's asynchronous work or a later resume event.
export function registerDeviceTrustLifecycle({ app, powerMonitor, service }) {
  const listeners = [
    [app, 'before-quit'],
    [powerMonitor, 'lock-screen'],
    [powerMonitor, 'suspend'],
    [powerMonitor, 'user-did-resign-active'],
  ].map(([emitter, event]) => {
    const listener = () => service.lock(event);
    emitter.on(event, listener);
    return () => emitter.removeListener(event, listener);
  });
  return () => { for (const remove of listeners) remove(); service.lock('dispose'); };
}
