import { fileURLToPath } from "node:url";

export const DESKTOP_NAME = "半人马AI-万象";
export const DESKTOP_ENGLISH_NAME = "CentaurAI-WanX";
const resource = (name) => fileURLToPath(new URL(`../resources/${name}`, import.meta.url));
export const APP_ICON = resource("icon.png");

export function createDesktopIntegration({
  app, Menu, Tray, nativeImage, control, client, openDashboard, onError,
  panel, screen, openManagement, onPanelHidden = () => {},
  requestQuit = () => app.quit(),
  platform = process.platform,
}) {
  const mac = platform === "darwin";
  const usesPanel = (mac || platform === "win32") && Boolean(panel);
  app.setAboutPanelOptions({
    applicationName: DESKTOP_NAME,
    applicationVersion: app.getVersion(),
    iconPath: APP_ICON,
    credits: `${DESKTOP_ENGLISH_NAME}\n你的 AI 应用底座`,
  });
  if (mac) app.dock.setIcon(APP_ICON);
  if (mac && usesPanel) app.dock.hide();
  const trayImage = nativeImage.createFromPath(resource(mac ? "trayTemplate.png" : platform === "win32" ? "icon.ico" : "tray.png"));
  if (mac) trayImage.setTemplateImage(true);
  const tray = new Tray(trayImage);
  tray.setToolTip(DESKTOP_NAME);
  let panelHeight = 520;
  let trayBlurAt = 0;
  let hidingPanel = false;

  function showControl() {
    if (control.isDestroyed()) return;
    if (control.isMinimized()) control.restore();
    control.show();
    control.focus();
  }

  function positionPanel() {
    if (!usesPanel || panel.isDestroyed()) return;
    const bounds = tray.getBounds();
    const anchored = bounds.width > 0 && bounds.height > 0;
    const display = anchored
      ? screen?.getDisplayMatching(bounds)
      : screen?.getDisplayNearestPoint(screen.getCursorScreenPoint());
    if (!display) {
      panel.setBounds({ width: 400, height: panelHeight });
      return;
    }
    const area = display.workArea;
    const margin = 8;
    const width = Math.max(1, Math.min(400, area.width - margin * 2));
    const height = Math.max(1, Math.min(panelHeight, area.height - margin * 2));
    const left = area.x + margin;
    const top = area.y + margin;
    let x = anchored ? bounds.x + bounds.width / 2 - width / 2 : area.x + area.width - width - margin;
    let y = anchored ? bounds.y + bounds.height + margin : mac ? top : area.y + area.height - height - margin;
    if (anchored && !mac) {
      if (bounds.y >= area.y + area.height) y = bounds.y - height - margin;
      else if (bounds.y + bounds.height <= area.y) y = bounds.y + bounds.height + margin;
      else if (bounds.x >= area.x + area.width) {
        x = bounds.x - width - margin;
        y = bounds.y + bounds.height / 2 - height / 2;
      } else if (bounds.x + bounds.width <= area.x) {
        x = bounds.x + bounds.width + margin;
        y = bounds.y + bounds.height / 2 - height / 2;
      } else y = bounds.y - height - margin;
    }
    panel.setBounds({
      x: Math.round(Math.max(left, Math.min(x, area.x + area.width - width - margin))),
      y: Math.round(Math.max(top, Math.min(y, area.y + area.height - height - margin))),
      width, height,
    });
  }

  function hidePanel({ preserveIntent = false } = {}) {
    if (!usesPanel || panel.isDestroyed() || hidingPanel) return;
    const visible = panel.isVisible();
    if (!visible) return;
    hidingPanel = true;
    try { panel.hide(); }
    finally { hidingPanel = false; }
    if (!preserveIntent) onPanelHidden();
  }

  function show() {
    if (!usesPanel) { showControl(); return; }
    if (panel.isDestroyed()) return;
    trayBlurAt = 0;
    positionPanel();
    panel.show();
    panel.focus();
  }

  function showManagement(page = "applications") {
    hidePanel({ preserveIntent: true });
    if (openManagement) { openManagement(page); return; }
    showControl();
    if (!control.isDestroyed() && client.snapshot().account?.phase === "authenticated")
      control.webContents.send("wanx-client:navigate", page);
  }

  function resizePanel(height) {
    if (!Number.isFinite(height)) return;
    panelHeight = Math.max(240, Math.min(560, Math.round(height)));
    positionPanel();
  }

  function togglePanel() {
    // Clicking the tray can blur the window before the tray's click arrives.
    // Keep that same click from reopening the panel that blur just hid.
    if (trayBlurAt && Date.now() - trayBlurAt < 300) { trayBlurAt = 0; return; }
    if (panel.isVisible()) hidePanel();
    else show();
  }

  function panelBlurred() {
    if (hidingPanel || panel.isDestroyed() || !panel.isVisible()) return;
    const point = screen?.getCursorScreenPoint();
    const bounds = tray.getBounds();
    if (point && point.x >= bounds.x && point.x < bounds.x + bounds.width &&
        point.y >= bounds.y && point.y < bounds.y + bounds.height) trayBlurAt = Date.now();
    else trayBlurAt = 0;
    hidePanel();
  }

  function updatePanelPosition() {
    if (usesPanel && !panel.isDestroyed() && panel.isVisible()) positionPanel();
  }

  const dashboard = () => Promise.resolve().then(openDashboard).catch(onError);
  const homeItem = () => ({ id: "applications", label: "我的应用", accelerator: "CmdOrCtrl+1", click: () => usesPanel ? show() : showManagement("applications") });
  const settingsItem = () => ({ id: "settings", label: "设置…", accelerator: "CmdOrCtrl+,", click: () => showManagement("settings") });
  const dashboardItem = () => ({ id: "dashboard", label: "打开 Dashboard", accelerator: "CmdOrCtrl+Shift+D", click: dashboard });
  const separator = { type: "separator" };
  const about = { role: "about", label: "关于万象" };
  const quit = mac
    ? { id: "quit", label: "退出万象", accelerator: "Command+Q", click: requestQuit }
    : { role: "quit", label: "退出万象" };
  const menu = Menu.buildFromTemplate([
    ...(mac ? [{ label: DESKTOP_NAME, submenu: [
      about, separator, settingsItem(), separator,
      { role: "services", label: "服务" }, separator,
      { role: "hide", label: `隐藏${DESKTOP_NAME}` },
      { role: "hideOthers", label: "隐藏其他应用" },
      { role: "unhide", label: "显示全部" }, separator, quit,
    ] }] : []),
    { label: "应用", submenu: [
      { label: usesPanel ? "打开万象" : "显示主窗口", accelerator: "CmdOrCtrl+Shift+M", click: show },
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
  if (platform === "win32") {
    control.setMenu?.(null);
    control.setMenuBarVisibility?.(false);
  }
  const trayMenu = Menu.buildFromTemplate([
    { id: "connection-status", label: "未连接盒子", enabled: false }, separator,
    { label: usesPanel ? "打开万象" : "显示主窗口", click: show }, homeItem(), settingsItem(), dashboardItem(),
    separator, about, quit,
  ]);

  let previous;
  function sync(state) {
    const signedIn = state.account?.phase === "authenticated";
    const networkReady = signedIn && state.network?.enabled !== false &&
      state.platform?.phase === "ready" && state.network?.phase === "ready";
    const connected = signedIn && state.phase === "ready" &&
      Boolean(state.connection?.deviceId && state.connection.gatewayURL) &&
      (state.connection.mode === "local" || (networkReady && state.connection.mode === "netbird"));
    const unavailable = state.platform?.phase === "unavailable" || ["unavailable", "failed", "error"].includes(state.network?.phase);
    const label = !signedIn ? "尚未登录万象" : connected ? `已连接 · ${state.connection.name || state.connection.deviceId}` : state.network?.enabled === false ? "网络已关闭" :
      unavailable ? "网络暂不可用" : !networkReady ? "网络连接中" :
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
    if (!usesPanel) tray.setContextMenu(trayMenu);
  }
  const hideOnClose = (event) => { event.preventDefault(); control.hide(); };
  const hidePanelOnClose = (event) => { event.preventDefault(); hidePanel(); };
  const showTrayMenu = () => { hidePanel(); tray.popUpContextMenu(trayMenu); };
  control.on("close", hideOnClose);
  app.on("activate", show);
  if (usesPanel) {
    panel.on("close", hidePanelOnClose);
    panel.on("blur", panelBlurred);
    tray.on("click", togglePanel);
    if (platform === "win32") tray.on("double-click", show);
    tray.on("right-click", showTrayMenu);
    for (const event of ["display-added", "display-removed", "display-metrics-changed"])
      screen?.on(event, updatePanelPosition);
  } else {
    if (!mac) tray.on("click", show);
    tray.on("double-click", show);
  }
  sync(client.snapshot());

  return {
    sync,
    show,
    showManagement,
    hidePanel,
    resizePanel,
    dispose() {
      control.removeListener("close", hideOnClose);
      app.removeListener("activate", show);
      if (usesPanel) {
        panel.removeListener("close", hidePanelOnClose);
        panel.removeListener("blur", panelBlurred);
        for (const event of ["display-added", "display-removed", "display-metrics-changed"])
          screen?.removeListener(event, updatePanelPosition);
      }
      tray.destroy();
    },
  };
}
