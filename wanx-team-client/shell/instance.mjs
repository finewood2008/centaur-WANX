// A single user-data directory owns one network identity and one sidecar.
export function claimSingleInstance(app, getControl, onCommandLine) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on("second-instance", (_event, argv) => {
    if (onCommandLine?.(argv)) return;
    const control = getControl();
    if (!control || control.isDestroyed()) return;
    if (control.isMinimized()) control.restore();
    control.show();
    control.focus();
  });
  return true;
}
