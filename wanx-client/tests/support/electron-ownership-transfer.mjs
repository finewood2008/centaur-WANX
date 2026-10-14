import assert from "node:assert/strict";
import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { createAccount } from "../../account/index.mjs";
import { createPlatformClient } from "../../platform.mjs";
import { registerControlActions } from "../../shell/control.mjs";

let window, client;
async function verify() {
  const calls = [], errors = [];
  let saved, owner = true, transfer;
  const ownedBox = { deviceId: "box-one", displayName: "客户交付测试盒子", deviceRole: "owner", accessState: "ready" };
  const sharedBoxes = Array.from({ length: 12 }, (_, index) => ({ deviceId: `box-shared-${index}`, displayName: `共享盒子 ${index + 1}`, deviceRole: "member", accessState: "ready" }));
  const reply = data => new Response(JSON.stringify({ code: 200, data }));
  try {
    await app.whenReady();
    const account = createAccount({ store: { load: async () => saved, save: async value => { saved = value; } }, fetch: async (url, options) => {
      const body = options.body && JSON.parse(options.body);
      calls.push({ path: new URL(url).pathname, body });
      if (url.endsWith("/login")) return reply({ accountId: body.phone, clientId: body.clientId, accessToken: "fake", refreshToken: "fake-refresh", expiresIn: 3600 });
      if (url.endsWith("/sms/send")) { await new Promise(r => setTimeout(r, 50)); return reply({ expiresIn: 300 }); }
      if (url.endsWith("/devices")) return reply(owner ? [{ deviceId: "box-one", role: "owner", status: "active" }] : []);
      if (url.endsWith("/network/boxes")) return reply({ boxes: owner ? [...sharedBoxes.slice(0, 6), ownedBox, ...sharedBoxes.slice(6)] : [] });
      if (url.endsWith("/ownership/transfer")) {
        transfer = { transferId: "transfer-one", deviceId: "box-one", direction: "outgoing", state: "pending_target", retainData: true, ownershipEpoch: 2, expiresAt: "2099-01-01T00:00:00Z" };
        return reply(transfer);
      }
      if (url.endsWith("/ownership/transfers")) return reply(transfer ? [{ ...transfer, direction: owner ? "outgoing" : "incoming" }] : []);
      if (url.endsWith("/accept")) { transfer.state = "completed"; owner = true; return reply({ ...transfer, direction: "incoming" }); }
      if (url.endsWith("/logout") || options.method === "DELETE") return reply({});
      throw new Error(`Unexpected mock endpoint ${url}`);
    } });
    client = createPlatformClient({ account, readPreference: async () => false });
    await client.initialize();
    await client.loginPassword({ phone: "13800138000", password: "fake" });
    const index = new URL("../../local-ui/renderer/index.html", import.meta.url);
    window = new BrowserWindow({ show: false, width: 1180, height: 900, webPreferences: { preload: fileURLToPath(new URL("../../local-ui/remote-preload.cjs", import.meta.url)), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
    registerControlActions({ ipcMain, control: window, controlURL: index.href, client, market: { list: async () => ({ items: [] }) } });
    client.subscribe(state => window.webContents.send("wanx-client:state", state));
    await window.loadFile(fileURLToPath(index));
    const js = value => window.webContents.executeJavaScript(value);
    await js(`window.until = async predicate => { for(let i=0;i<100;i++){ if(predicate()) return; await new Promise(r=>setTimeout(r,20)); } throw Error('UI timeout'); }; window.click = action => document.querySelector('[data-action="'+action+'"]').click(); void 0;`);
    await js(`(async()=>{ await until(()=>!!document.querySelector('[data-action="show-settings"]')); click('show-settings'); click('show-boxes'); await until(()=>!!document.querySelector('[data-action="transfer-open"]')); if(document.querySelectorAll('[data-action="transfer-open"]').length!==1) throw Error('member sees transfer'); document.querySelector('[data-action="transfer-open"]').scrollIntoView({block:'center'}); click('transfer-open');
      const form = document.querySelector('[data-form="transfer"]');
      const phone = form.querySelector('[name="targetPhone"]');
      const headerBottom = document.querySelector('.topbar').getBoundingClientRect().bottom;
      const titleRect = form.querySelector('h3').getBoundingClientRect();
      const phoneRect = phone.getBoundingClientRect();
      if(titleRect.top < headerBottom || phoneRect.bottom > innerHeight) throw Error('transfer form opened outside visible viewport');
      if(document.activeElement !== phone) throw Error('transfer phone did not receive focus');
      document.querySelector('[name="targetPhone"]').value='13900139000'; document.querySelector('[name="verificationCode"]').value='012345'; document.querySelector('[name="retainData"]').checked=true; click('transfer-code'); click('transfer-code'); await until(()=>document.body.textContent.includes('验证码已发送')); })()`);
    assert.equal(calls.filter(call => call.path.endsWith("/sms/send")).length, 1);
    window.webContents.send("wanx-client:state", client.snapshot());
    await js(`(async()=>{ await new Promise(r=>setTimeout(r,30)); if(document.querySelector('[name="targetPhone"]').value!=='13900139000'||document.querySelector('[name="verificationCode"]').value!=='012345') throw Error('poll erased input'); if(document.documentElement.scrollWidth>innerWidth) throw Error('horizontal overflow'); })()`);
    if (process.env.WANX_TRANSFER_SCREENSHOT) await writeFile(process.env.WANX_TRANSFER_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    await js(`(async()=>{ document.querySelector('[data-form="transfer"]').requestSubmit(); await until(()=>document.body.textContent.includes('邀请已发送')); if(document.querySelector('[name="verificationCode"]')) throw Error('code retained after submit'); })()`);
    const created = calls.find(call => call.path.endsWith("/ownership/transfer"));
    assert.deepEqual(created.body, { ownerPhone: "13800138000", verificationCode: "012345", targetPhone: "13900139000", retainData: true });
    await client.logout(); owner = false;
    await client.loginPassword({ phone: "13900139000", password: "fake" });
    await js(`(async()=>{ await until(()=>!!document.querySelector('[data-action="show-settings"]')); click('show-settings'); click('show-boxes'); await until(()=>!!document.querySelector('[data-action="transfer-accept"]')); click('transfer-accept'); await until(()=>document.body.textContent.includes('接受盒子所有权')); })()`);
    assert.equal(calls.some(call => call.path.endsWith("/accept")), false);
    await js(`(async()=>{ click('market-confirm'); await until(()=>document.body.textContent.includes('已接受所有权')); if(document.querySelector('[data-action="transfer-accept"]')) throw Error('completed invitation still actionable'); })()`);
    assert.equal(calls.filter(call => call.path.endsWith("/accept")).length, 1);
    assert.deepEqual(errors, []);
    console.log("OWNERSHIP_ELECTRON_PASS: owner-only UI, signed transfer, phone identity, SMS double-click, form retention, explicit recipient confirmation, refreshed ownership");
  } catch(error) { console.error(error); process.exitCode = 1; }
  finally { await client?.close(); window?.destroy(); app.exit(process.exitCode || 0); }
}
void verify();
