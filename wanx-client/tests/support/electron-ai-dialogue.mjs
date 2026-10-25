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
    await control.webContents.executeJavaScript(await readFile(new URL('../../local-ui/renderer/ai-dialogue.js', import.meta.url), 'utf8'));
    await control.webContents.executeJavaScript(`
      window.calls = []; window.scope = 'synthetic-scope';
      window.box = { phase:'ready', account:{phase:'authenticated',accountId:'synthetic-owner',clientId:'pc'}, connection:{deviceId:'synthetic-box',gatewayURL:'http://127.0.0.1',name:'Synthetic box'} };
      window.ui = createAIDialogueView({ request:async(method,input)=>{
        calls.push({method,input});let value={scope};
        if(method==='dialogue.load')value={scope,models:[{id:'fixture/one',name:'One',provider:'fixture',input:['text']},{id:'fixture/two',name:'Two',provider:'fixture',input:['text']}],defaultModel:'fixture/one',sessions:[{thread_id:'thread-1',title:'Synthetic conversation'}],legacySessions:[]};
        if(method==='dialogue.open')value={scope,conversation:{id:'thread-1',active_thread_id:'thread-1',revision:0,context:{space:{enabled:false},knowledge:{enabled:false,warehouses:[]}},versions:[{thread_id:'thread-1',kind:'original'}]},history:{thread_id:'thread-1',messages:[],model_ref:'fixture/one',turn_active:false,hitl_pending:null}};
        return {ok:true,value};
      }});
      ui.hostState(box);ui.visible(true);ui.mount(document.getElementById('host'));
      window.check=(yes,message)=>{if(!yes)throw Error(message)};
      window.until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10))}throw Error('UI timeout: '+predicate)};
      void 0;
    `);
    await control.webContents.executeJavaScript(`(async()=>{
      await until(()=>document.querySelector('[data-chat-action="open"][data-id="thread-1"]'));
      document.querySelector('[data-chat-action="open"][data-id="thread-1"]').click();
      await until(()=>ui.snapshot().conversationId==='thread-1');
      await until(()=>!document.querySelector('[data-chat-input]').disabled);
      const input=document.querySelector('[data-chat-input]');input.value='Unsent synthetic draft';input.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('[data-chat-action="model"][data-id="fixture/two"]').click();
      await until(()=>ui.snapshot().model==='fixture/two');
      check(ui.snapshot().conversationId==='thread-1','model switch lost conversation');
      check(ui.snapshot().draft==='Unsent synthetic draft','model switch lost draft');
      check(!calls.some(c=>c.method==='dialogue.send'||c.method==='dialogue.version'),'model switch generated a turn');
      ui.hostState({...box,account:{...box.account,phase:'signed_out'}});
      check(ui.snapshot().scope===null&&ui.snapshot().draft===''&&ui.snapshot().conversationId===null,'sign out retained private state');
      ui.hostState(box);await until(()=>ui.snapshot().scope==='synthetic-scope');
      check(ui.snapshot().draft===''&&ui.snapshot().conversationId===null,'reconnect restored another account draft');
    })().catch(error=>{console.error(error.stack);throw error})`);
    process.stdout.write('AI_DIALOGUE_UI_PASS\n');app.exit(0);
  } catch(error) { console.error(error);app.exit(1); }
}
void verify();
