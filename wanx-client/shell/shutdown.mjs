// Electron emits before-quit again for repeated user actions and for our final quit.
// Only the latter may bypass cleanup; a failed stop must leave Host available to retry.
export function registerShutdown({ app, closeApplications, closeHost, onError }) {
  let ready = false, pending;
  app.on("before-quit", event => {
    if (ready) return;
    event.preventDefault();
    if (pending) return;
    pending = Promise.resolve()
      .then(closeApplications)
      .then(closeHost)
      .then(() => { ready = true; app.quit(); })
      .catch(onError)
      .finally(() => { pending = null; });
  });
}
