// A single user-data directory owns one network identity and one sidecar.
export function claimSingleInstance(app, getControl) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on("second-instance", () => {
    const control = getControl();
    if (!control || control.isDestroyed()) return;
    if (control.isMinimized()) control.restore();
    control.show();
    control.focus();
  });
  return true;
}
