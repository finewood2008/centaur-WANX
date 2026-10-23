export function attach(app, sourceDevelopment) {
      app.on("second-instance", () => { void sourceDevelopment.open().catch(() => {}); });
}
