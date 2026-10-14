import { readBluetoothState } from "./bluetooth-state.mjs";
const CHANNEL = "wanx:discovery:open-bluetooth-settings";

// Only fixed OS settings destinations can cross this IPC boundary.
export function installBluetoothSettings({ webContents, ipcMain, documentUrl,
  platform = process.platform, openExternal = async (url) => (await import("electron")).shell.openExternal(url),
}) {
  const trusted = event => event.sender === webContents && event.senderFrame === webContents.mainFrame &&
    event.senderFrame?.url === documentUrl;
  let checking;
  ipcMain.handle("wanx:discovery:bluetooth-state", async event => {
    if (!trusted(event)) return { status: "error" };
    if (!checking) checking = readBluetoothState({ platform }).finally(() => { checking = undefined; });
    return checking;
  });
  ipcMain.handle(CHANNEL, async (event, section) => {
    if (event.sender !== webContents || event.senderFrame !== webContents.mainFrame ||
        event.senderFrame?.url !== documentUrl)
      return { ok: false, code: "IPC_ACCESS_DENIED" };
    if (!["bluetooth", "privacy"].includes(section))
      return { ok: false, code: "INVALID_REQUEST" };
    const url = platform === "darwin"
      ? section === "privacy"
        ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Bluetooth"
        : "x-apple.systempreferences:com.apple.Bluetooth"
      : platform === "win32" ? "ms-settings:bluetooth" : null;
    if (!url) return { ok: false, code: "BLUETOOTH_SETTINGS_UNAVAILABLE" };
    try {
      await openExternal(url);
      return { ok: true };
    } catch {
      return { ok: false, code: "BLUETOOTH_SETTINGS_UNAVAILABLE" };
    }
  });
  return () => {
    ipcMain.removeHandler(CHANNEL);
    ipcMain.removeHandler("wanx:discovery:bluetooth-state");
  };
}
