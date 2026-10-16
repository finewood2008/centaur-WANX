import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";

export function createStartupSettings({ app, platform = process.platform, preferenceFile, argv = process.argv, testBuild = false }) {
  // Installed branded source builds have a stable launchable bundle too.
  const installedBundle = platform === "darwin" && app.isInApplicationsFolder?.() === true &&
    path.basename(path.resolve(app.getPath("exe"), "../../..")) === "万象.app";
  const windows = platform === "win32";
  const supported = !testBuild && ["darwin", "win32"].includes(platform) && (app.isPackaged || installedBundle);
  const loginArguments = ["--wanx-login-startup"];
  const loginOptions = windows && supported ? { path: app.getPath("exe"), args: loginArguments } : {};
  const readSettings = () => windows ? app.getLoginItemSettings(loginOptions) : app.getLoginItemSettings();
  const writeSettings = enabled => app.setLoginItemSettings({ openAtLogin: enabled,
    ...(windows ? { ...loginOptions, enabled, name: "万象" } : {}) });
  const preferences = preferenceFile ?? (app.getPath ? path.join(app.getPath("userData"), "startup-preferences.json") : null);
  function remember(enabled) {
    if (!preferences) return;
    mkdirSync(path.dirname(preferences), { recursive: true });
    const temporary = `${preferences}.tmp`;
    writeFileSync(temporary, JSON.stringify({ initialized: true, enabled }) + "\n", { mode: 0o600 });
    renameSync(temporary, preferences);
  }
  const unavailable = () => ({
    supported: false,
    enabled: false,
    status: "unsupported",
    reason: testBuild ? "测试版本不注册登录启动。" : !["darwin", "win32"].includes(platform)
      ? "此版本暂不支持设置登录时启动。"
      : "请安装正式版万象后设置登录时启动。",
  });

  function get() {
    if (!supported) return unavailable();
    const settings = readSettings();
    const status = windows && settings.openAtLogin && settings.executableWillLaunchAtLogin === false ? "disabled" : settings.status || (settings.openAtLogin ? "enabled" : "not-registered");
    return {
      supported: true,
      enabled: settings.openAtLogin === true && status === "enabled",
      status,
      reason: status === "requires-approval"
        ? "请在系统设置中允许万象登录时启动。"
        : status === "disabled" ? "已在系统启动应用设置中关闭，可在此重新开启。"
        : status === "not-found" ? "系统未找到万象，请从安装位置重新打开应用。" : null,
    };
  }

  return Object.freeze({
    get,
    initializeDefault() {
      if (!supported) return unavailable();
      if (!preferences) throw new Error("缺少启动偏好存储位置。");
      try {
        const saved = JSON.parse(readFileSync(preferences, "utf8"));
        if (saved.initialized === true) return get();
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      const current = get();
      if (!current.enabled && ["not-registered", "not-found"].includes(current.status)) {
        writeSettings(true);
        const updated = get();
        if (updated.enabled || updated.status === "requires-approval") remember(true);
        return updated;
      }
      remember(current.enabled);
      return current;
    },
    set(enabled) {
      if (typeof enabled !== "boolean") throw new TypeError("启动设置必须为布尔值。");
      if (!supported) return unavailable();
      writeSettings(enabled);
      const result = get();
      remember(enabled);
      return result;
    },
    wasOpenedAtLogin() {
      return supported && (windows ? argv.includes("--wanx-login-startup") : readSettings().wasOpenedAtLogin === true);
    },
  });
}
