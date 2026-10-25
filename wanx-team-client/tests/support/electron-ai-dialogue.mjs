import { app, BrowserWindow } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
let control;
async function verify() {
  try {
    await app.whenReady();
    control = new BrowserWindow({ show: false, width: 900, height: 760, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    control.webContents.on('console-message', event => { if(event.level === 'error') console.error(event.message); });
    const base = new URL('../../local-ui/renderer/index.html', import.meta.url);
    const html = app.getPath('userData') + '/chat-ui-test.html';
    await writeFile(html, `<html><head><base href="${base.href}"></head><body><main id="host" style="height:100vh"></main></body></html>`);
    await control.loadFile(html);
    for (const name of ['styles.css', 'ai-dialogue.css']) await control.webContents.insertCSS(await readFile(new URL('../../local-ui/renderer/' + name, import.meta.url), 'utf8'));
    await control.webContents.executeJavaScript((await readFile(new URL('../../local-ui/renderer/ai-dialogue.js', import.meta.url), 'utf8'))+'\n;void 0;');
    await control.webContents.executeJavaScript(`
      window.calls = []; window.scope = 'synthetic-scope'; window.channelRows=[];
      window.box = { phase:'ready', account:{phase:'authenticated',accountId:'synthetic-owner',clientId:'pc'}, connection:{deviceId:'synthetic-box',gatewayURL:'http://127.0.0.1',name:'Synthetic box'} };
      window.ui = createAIDialogueView({ request:window.nativeRequest=async(method,input)=>{
        calls.push({method,input});let value={scope};
        if(method==='dialogue.load')value={scope,models:[{id:'fixture/one',name:'One',provider:'fixture',input:['text']},{id:'fixture/two',name:'Two',provider:'fixture',input:['text']}],defaultModel:'fixture/one',sessions:[{thread_id:'thread-1',title:'Synthetic conversation'}],legacySessions:[]};
        if(method==='dialogue.open')value={scope,conversation:{id:'thread-1',active_thread_id:'thread-1',revision:0,context:{space:{enabled:false},knowledge:{enabled:false,warehouses:[]}},versions:[{thread_id:'thread-1',kind:'original'}]},history:{thread_id:'thread-1',messages:[],model_ref:'fixture/one',turn_active:false,hitl_pending:null}};
        if(method==='dialogue.channels-list')value={scope,items:channelRows};
        if(method==='dialogue.channels-save'){const row={id:'channel-1',kind:input.kind,name:input.name,enabled:true,status:'connected'};channelRows=[row];value={scope,channel:row};}
        if(method==='dialogue.channels-detail')value={scope,channel:channelRows[0],values:{app_id:'synthetic-app'},configured:['app_secret']};
        if(method==='dialogue.channels-delete'){channelRows=[];value={scope};}
        if(method==='dialogue.channels-start')value={scope,handle:'synthetic-ticket',interval:60000,qr:'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIj48L3N2Zz4='};
        return {ok:true,value};
      }});
      ui.hostState(box);ui.visible(true);ui.mount(document.getElementById('host'));
      window.check=(yes,message)=>{if(!yes)throw Error(message)};
      window.until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10))}throw Error('UI timeout: '+predicate)};
      void 0;
    `);
    await control.webContents.executeJavaScript(`(async()=>{
      await until(()=>document.querySelector('[data-chat-action="open"][data-id="thread-1"]'));
      const history=document.querySelector('[data-chat-history]'),leading=document.querySelector('.ai-heading-left [data-chat-action="history"]'),title=document.querySelector('.ai-page-title');
      check(leading&&leading.getBoundingClientRect().left<title.getBoundingClientRect().left,'history action is not before the title');
      check(!history.hidden&&leading.getAttribute('aria-expanded')==='true','full assistant history must start expanded');
      leading.click();check(history.hidden,'history did not collapse');leading.click();check(!history.hidden,'history did not expand');
      check(document.documentElement.scrollWidth<=innerWidth,'assistant overflows horizontally');
      document.querySelector('[data-chat-action="open"][data-id="thread-1"]').click();
      await until(()=>ui.snapshot().conversationId==='thread-1');
      await until(()=>!document.querySelector('[data-chat-input]').disabled);
      const input=document.querySelector('[data-chat-input]');input.value='Unsent synthetic draft';input.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('[data-chat-action="model"][data-id="fixture/two"]').click();
      await until(()=>ui.snapshot().model==='fixture/two');
      check(ui.snapshot().conversationId==='thread-1','model switch lost conversation');
      check(ui.snapshot().draft==='Unsent synthetic draft','model switch lost draft');
      check(!calls.some(c=>c.method==='dialogue.send'||c.method==='dialogue.version'),'model switch generated a turn');
      const channelButton=document.querySelector('[data-assistant-channels]');check(channelButton,'full assistant has no channel entry');
      check(getComputedStyle(channelButton).borderRadius===getComputedStyle(leading).borderRadius,'header action radii differ');
      channelButton.click();await until(()=>document.querySelectorAll('.ai-channel-card').length===4);
      const dialog=document.querySelector('.ai-channels-dialog');check(dialog.open,'channel dialog did not open');
      check(ui.snapshot().draft==='Unsent synthetic draft','channel settings lost the draft');
      await until(()=>[...dialog.querySelectorAll('img')].every(image=>image.complete&&image.naturalWidth>0));
      dialog.querySelector('[data-channel-action="connect"][data-kind="feishu"]').click();
      await until(()=>dialog.querySelector('[data-channel-form]'));dialog.querySelector('.ai-channel-manual').open=true;
      const form=dialog.querySelector('[data-channel-form]');
      for(const [name,value]of Object.entries({name:'Synthetic connection',app_id:'synthetic-app',app_secret:'synthetic-secret'}))form.elements.namedItem(name).value=value;
      form.requestSubmit();await until(()=>dialog.querySelector('[data-channel-action="edit"]'));
      dialog.querySelector('[data-channel-action="edit"]').click();await until(()=>dialog.querySelector('[data-channel-action="delete-ask"]'));
      check(dialog.querySelector('input[name="app_secret"]').value==='','channel edit exposed a secret');
      dialog.querySelector('[data-channel-action="delete-ask"]').click();check(!calls.some(c=>c.method==='dialogue.channels-delete'),'removal skipped confirmation');
      dialog.querySelector('[data-channel-action="delete-cancel"]').click();check(dialog.querySelector('.ai-channel-remove').hidden,'removal cancellation failed');
      dialog.querySelector('[data-channel-action="delete-ask"]').click();dialog.querySelector('[data-channel-action="delete"]').click();
      await until(()=>channelRows.length===0&&dialog.querySelectorAll('.ai-channel-card').length===4);
      dialog.querySelector('[data-channel-action="connect"][data-kind="weixin"]').click();await until(()=>dialog.querySelector('[data-channel-action="start"]'));
      dialog.querySelector('[data-channel-action="start"]').click();await until(()=>dialog.querySelector('[data-channel-qr] img'));
      dialog.querySelector('[data-channel-action="close"]').click();await until(()=>calls.some(c=>c.method==='dialogue.channels-cancel'));
      check(!dialog.open,'channel dialog did not close');
      check(!calls.some(c=>c.method==='dialogue.send'),'channel settings sent a message');
      channelButton.click();await until(()=>dialog.open&&dialog.querySelectorAll('.ai-channel-card').length===4);

      ui.hostState({...box,account:{...box.account,phase:'signed_out'}});
      check(ui.snapshot().scope===null&&ui.snapshot().draft===''&&ui.snapshot().conversationId===null,'sign out retained private state');
      check(!dialog.open&&dialog.querySelectorAll('input').length===0,'account switch retained channel configuration');
      ui.hostState(box);await until(()=>ui.snapshot().scope==='synthetic-scope');
      check(ui.snapshot().draft===''&&ui.snapshot().conversationId===null,'reconnect restored another account draft');
      check(!document.querySelector('[data-chat-history]').hidden,'reconnected full assistant must restore the default history state');
      const miniHost=document.createElement('div');miniHost.id='assistant-mini-host';document.body.append(miniHost);
      const mini=createAIDialogueView({compact:true,request:nativeRequest});mini.hostState(box);mini.visible(true);mini.mount(miniHost);
      await until(()=>mini.snapshot().scope==='synthetic-scope');
      check(miniHost.querySelector('[data-chat-history]').hidden,'mini assistant history must start collapsed');
      check(!miniHost.querySelector('[data-assistant-channels]'),'mini unexpectedly exposes channel settings');
      mini.hostState({...box,account:{...box.account,phase:'signed_out'}});
    })().catch(error=>{console.error(error.stack);throw error})`);
    control.setSize(520,760);
    await control.webContents.executeJavaScript(`(async()=>{
      await until(()=>innerWidth<=520);
      document.querySelector('[data-assistant-channels]').click();await until(()=>document.querySelectorAll('.ai-channel-card').length===4);
      const dialog=document.querySelector('.ai-channels-dialog');check(dialog.scrollWidth<=dialog.clientWidth,'narrow channel settings overflow horizontally');
      dialog.querySelector('[data-channel-action="close"]').click();
    })().catch(error=>{console.error(error.stack);throw error})`);
    process.stdout.write('AI_DIALOGUE_UI_PASS\n');app.exit(0);
  } catch(error) { console.error(error);app.exit(1); }
}
void verify();
