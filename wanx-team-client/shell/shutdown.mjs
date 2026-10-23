// Electron emits before-quit again for repeated user actions and for our final quit.
// Only the latter may bypass cleanup; a failed stop must leave Host available to retry.
export function registerShutdown({ app, closeApplications, closeHost, onError }) {
  let ready = false, pending;
  function finish(finalize = () => app.quit()) {
    if (pending) return pending;
    pending = Promise.resolve()
      .then(closeApplications)
      .then(closeHost)
      .then(() => { ready = true; return finalize(); })
      .catch(error => { ready = false; throw error; })
      .finally(() => { pending = null; });
    return pending;
  }
  app.on("before-quit", event => {
    if (ready) return;
    event.preventDefault();
    if (pending) return;
    void finish().catch(onError);
  });
  return {
    requestInstall(finalize) {
      if (pending) return Promise.reject(Object.assign(new Error("UPDATE_IN_PROGRESS"), { code: "UPDATE_IN_PROGRESS" }));
      return finish(finalize);
    },
  };
}
