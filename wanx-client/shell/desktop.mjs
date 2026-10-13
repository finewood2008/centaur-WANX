import { fileURLToPath } from "node:url";

export const DESKTOP_NAME = "万象";
const resource = (name) => fileURLToPath(new URL(`../resources/${name}`, import.meta.url));
export const APP_ICON = resource("icon.png");

export function createDesktopIntegration({
  app, Menu, Tray, nativeImage, control, client, openDashboard, onError,
  platform = process.platform,
}) {
  const mac = platform === "darwin";
  app.setAboutPanelOptions({
    applicationName: DESKTOP_NAME,
    applicationVersion: app.getVersion(),
    iconPath: APP_ICON,
    credits: "CentaurAI · 万象应用与设备连接",
  });
  if (mac) app.dock.setIcon(APP_ICON);
  const trayImage = nativeImage.createFromPath(resource(mac ? "trayTemplate.png" : platform === "win32" ? "icon.ico" : "tray.png"));
  if (mac) trayImage.setTemplateImage(true);
  const tray = new Tray(trayImage);
  tray.setToolTip(DESKTOP_NAME);

  function show() {
    if (control.isDestroyed()) return;
    if (control.isMinimized()) control.restore();
    control.show();
    control.focus();
  }
  function navigate(page) {
    show();
    if (!control.isDestroyed() && client.snapshot().account?.phase === "authenticated")
      control.webContents.send("wanx-client:navigate", page);
  }
  const dashboard = () => Promise.resolve().then(openDashboard).catch(onError);
  const homeItem = () => ({ id: "applications", label: "我的应用", accelerator: "CmdOrCtrl+1", click: () => navigate("applications") });
  const settingsItem = () => ({ id: "settings", label: "设置…", accelerator: "CmdOrCtrl+,", click: () => navigate("settings") });
  const dashboardItem = () => ({ id: "dashboard", label: "打开 Dashboard", accelerator: "CmdOrCtrl+Shift+D", click: dashboard });
  const separator = { type: "separator" };
  const about = { role: "about", label: `关于${DESKTOP_NAME}` };
  const quit = { role: "quit", label: `退出${DESKTOP_NAME}` };
  const menu = Menu.buildFromTemplate([
    ...(mac ? [{ label: DESKTOP_NAME, submenu: [
      about, separator, settingsItem(), separator,
      { role: "services", label: "服务" }, separator,
      { role: "hide", label: `隐藏${DESKTOP_NAME}` },
      { role: "hideOthers", label: "隐藏其他应用" },
      { role: "unhide", label: "显示全部" }, separator, quit,
    ] }] : []),
    { label: "应用", submenu: [
      { label: "显示主窗口", accelerator: "CmdOrCtrl+Shift+M", click: show },
      homeItem(), ...(!mac ? [settingsItem()] : []), dashboardItem(),
      ...(!mac ? [separator, about, quit] : []),
    ] },
    { label: "编辑", submenu: [
      { role: "undo", label: "撤销" }, { role: "redo", label: "重做" }, separator,
      { role: "cut", label: "剪切" }, { role: "copy", label: "复制" },
      { role: "paste", label: "粘贴" }, { role: "selectAll", label: "全选" },
    ] },
    { label: "显示", submenu: [
      { role: "resetZoom", label: "实际大小" }, { role: "zoomIn", label: "放大" },
      { role: "zoomOut", label: "缩小" }, separator,
      { role: "togglefullscreen", label: "切换全屏" },
      ...(!app.isPackaged ? [separator, { role: "toggleDevTools", label: "开发者工具" }] : []),
    ] },
    { role: "windowMenu", label: "窗口", submenu: [
      { role: "minimize", label: "最小化" }, { role: "close", label: "关闭窗口" },
      ...(mac ? [separator, { role: "front", label: "全部置前" }] : []),
    ] },
  ]);
  Menu.setApplicationMenu(menu);
  const trayMenu = Menu.buildFromTemplate([
    { id: "connection-status", label: "未连接盒子", enabled: false }, separator,
    { label: "显示主窗口", click: show }, homeItem(), settingsItem(), dashboardItem(),
    separator, quit,
  ]);

  let previous;
  function sync(state) {
    const signedIn = state.account?.phase === "authenticated";
    const networkReady = signedIn && state.network?.enabled !== false &&
      state.platform?.phase === "ready" && state.network?.phase === "ready";
    const connected = networkReady && state.phase === "ready" &&
      state.connection?.mode === "netbird" && Boolean(state.connection.deviceId && state.connection.gatewayURL);
    const unavailable = state.platform?.phase === "unavailable" || ["unavailable", "failed", "error"].includes(state.network?.phase);
    const label = !signedIn ? "尚未登录万象" : state.network?.enabled === false ? "网络已关闭" :
      unavailable ? "网络暂不可用" : !networkReady ? "网络连接中" :
      connected ? `已连接 · ${state.connection.name || state.connection.deviceId}` :
      state.phase === "recovering" ? "盒子连接恢复中" : state.phase === "connecting" ? "盒子连接中" : "未连接盒子";
    const key = JSON.stringify([signedIn, connected, label]);
    if (key === previous) return;
    previous = key;
    for (const target of [menu, trayMenu]) {
      target.getMenuItemById("applications").enabled = signedIn;
      target.getMenuItemById("settings").enabled = signedIn;
      target.getMenuItemById("dashboard").enabled = connected;
    }
    trayMenu.getMenuItemById("connection-status").label = label;
    tray.setContextMenu(trayMenu);
  }
  const hideOnClose = (event) => { event.preventDefault(); control.hide(); };
  control.on("close", hideOnClose);
  app.on("activate", show);
  if (!mac) tray.on("click", show);
  tray.on("double-click", show);
  sync(client.snapshot());

  return {
    sync,
    show,
    dispose() {
      control.removeListener("close", hideOnClose);
      app.removeListener("activate", show);
      tray.destroy();
    },
  };
}
