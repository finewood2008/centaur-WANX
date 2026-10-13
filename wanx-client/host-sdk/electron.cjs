// Call before taking a single-instance lock or creating any BrowserWindow.
function attachElectronHost() {
  if (!Object.keys(process.env).some(key => key.startsWith('WANX_HOST_'))) return false;
  if (!process.env.WANX_HOST_LAUNCH_ID || !process.env.WANX_HOST_TOKEN ||
      !process.env.WANX_HOST_CLIENT_APPLICATION_ID || !process.env.WANX_HOST_USER_DATA_DIR ||
      typeof process.send !== 'function') throw Object.assign(new Error('HOST_SESSION_MISSING'), {code:'HOST_SESSION_MISSING'});
  const {app} = require('electron');
  app.setPath('userData', process.env.WANX_HOST_USER_DATA_DIR);
  app.setPath('sessionData', process.env.WANX_HOST_USER_DATA_DIR);
  const windows = new Set();
  let reported = false;
  const report = type => {
    if (reported) return;
    reported = true;
    process.send({type, launchId:process.env.WANX_HOST_LAUNCH_ID}, () => {});
  };
  process.on('message', message => {
    if (message?.type !== 'wanx:application-activate' || message.launchId !== process.env.WANX_HOST_LAUNCH_ID) return;
    const window = [...windows].find(item => !item.isDestroyed());
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus(); app.focus({steal:true});
  });
  app.on('browser-window-created', (_event, window) => {
    windows.add(window);
    window.once('closed', () => windows.delete(window));
    window.webContents.once('did-finish-load', () => report('wanx:application-ready'));
    window.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (mainFrame !== false && code !== -3) report('wanx:application-failed');
    });
  });
  app.once('before-quit', () => report('wanx:application-failed'));
  return true;
}
module.exports = {attachElectronHost};
