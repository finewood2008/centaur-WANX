export function createStartupSettings({ app, platform = process.platform }) {
  const supported = platform === "darwin" && app.isPackaged;
  const unavailable = () => ({
    supported: false,
    enabled: false,
    status: "unsupported",
    reason: platform !== "darwin"
      ? "此版本暂不支持设置登录时启动。"
      : "请安装正式版万象后设置登录时启动。",
  });

  function get() {
    if (!supported) return unavailable();
    const settings = app.getLoginItemSettings();
    const status = settings.status || (settings.openAtLogin ? "enabled" : "not-registered");
    return {
      supported: true,
      enabled: settings.openAtLogin === true && status === "enabled",
      status,
      reason: status === "requires-approval"
        ? "请在系统设置中允许万象登录时启动。"
        : status === "not-found" ? "系统未找到万象，请从安装位置重新打开应用。" : null,
    };
  }

  return Object.freeze({
    get,
    set(enabled) {
      if (typeof enabled !== "boolean") throw new TypeError("启动设置必须为布尔值。");
      if (!supported) return unavailable();
      app.setLoginItemSettings({ openAtLogin: enabled });
      return get();
    },
    wasOpenedAtLogin() {
      return supported && app.getLoginItemSettings().wasOpenedAtLogin === true;
    },
  });
}
