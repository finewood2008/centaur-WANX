const {app, BrowserWindow} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
if (process.env.WANX_TEST_MODE === 'bundled') {
  require('@centaurai/wanx-host-sdk/electron').attachElectronHost();
}
const host = require('@centaurai/wanx-host-sdk').fromEnvironment();
let window, context, result, invalidated = false;
const send = value => process.send?.(value, () => {});

host.onSessionInvalidated(async () => {
  invalidated = true;
  context = null;
  result = null;
  if (window && !window.isDestroyed()) {
    await window.webContents.executeJavaScript("document.querySelector('#status').textContent='会话已失效';");
  }
  send({type:'test:invalidated'});
});
app.whenReady().then(async () => {
  context = await host.context();
  result = await (await host.request('/api/test')).json();
  window = new BrowserWindow({
    show:true, width:720, height:480, title:'万象应用安装验证',
    webPreferences:{nodeIntegration:false, sandbox:true, contextIsolation:true},
  });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
    <!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>万象应用安装验证</title>
    <style>body{font:18px system-ui;background:#faf7f0;color:#333;padding:36px}h1{font-size:30px;color:#a54f35}p{line-height:1.7}</style>
    <h1>应用已安装并打开</h1><p>${process.env.WANX_TEST_CASE}</p>
    <p id="status">盒子：${context.boxId} · 本地网关 API：${result.ok ? '成功' : '失败'}</p></html>
  `));
  send({type:'test:opened'});
}).catch(() => app.exit(1));

process.on('message', async message => {
  if (message?.type === 'test:hide') {
    window.hide();
    send({type:'test:hidden', visible:window.isVisible()});
  }
  if (message?.type === 'test:inspect') {
    const heading = await window.webContents.executeJavaScript("document.querySelector('h1').textContent");
    const screenshot = path.join(process.env.WANX_TEST_EVIDENCE_DIR, `${process.env.WANX_TEST_CASE}${invalidated ? '-revoked' : ''}.png`);
    await fs.writeFile(screenshot, (await window.webContents.capturePage()).toPNG());
    let revokedRequest;
    if (invalidated) {
      try { await host.request('/api/test'); }
      catch (error) { revokedRequest = error.code; }
    }
    send({type:'test:inspected', heading, screenshot, context, result, invalidated, revokedRequest,
      visible:window.isVisible(), packaged:app.isPackaged, userData:app.getPath('userData'),
      title:window.getTitle(), windowCount:BrowserWindow.getAllWindows().length});
  }
});
app.on('before-quit', () => host.close());
