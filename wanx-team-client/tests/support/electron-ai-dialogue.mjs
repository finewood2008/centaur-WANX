import { app, BrowserWindow } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
let control;
async function verify() {
  try {
    await app.whenReady();
    control = new BrowserWindow({ show: false, width: 900, height: 760, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const fixture = new URL('../../local-ui/renderer/index.html', import.meta.url);
    // Load a blank local document with the same base so bundled model icons use
    // the real packaged paths. All answers below are isolated synthetic fixtures.
    const htmlPath = app.getPath('userData') + '/chat-ui-test.html';
    await writeFile(htmlPath, `<html><head><base href="${fixture.href}"></head><body><main id="host" style="height:100vh"></main></body></html>`);
    await control.loadFile(htmlPath);
    await control.webContents.insertCSS(await readFile(new URL('../../local-ui/renderer/styles.css', import.meta.url), 'utf8'));
    await control.webContents.insertCSS(await readFile(new URL('../../local-ui/renderer/ai-dialogue.css', import.meta.url), 'utf8'));
    await control.webContents.executeJavaScript(await readFile(new URL('../../local-ui/renderer/ai-dialogue.js', import.meta.url), 'utf8'));
    await control.webContents.executeJavaScript(`
      window.calls = []; window.current = null; window.scope = 'scope-a'; window.modelChoices = null;
      window.archives = {}; window.nextSession = 0; window.modelSwitchSupport = 0;
      window.boxState = { account: { phase: 'authenticated', accountId: 'owner', clientId: 'pc', profile: { displayName: '小万' } }, activeDeviceId: 'box-a', connection: { name: '测试盒子', gatewayURL: 'http://local' } };
      window.ui = createAIDialogueView({ onBoxes() {}, request: window.dialogueRequest = async (method, input) => {
        calls.push({ method, input });
        if (method === 'dialogue.open') {
          const session = structuredClone(archives[input.sessionId]);
          if (window.deferOpen) return new Promise(resolve => { window.resolveOpen = () => resolve({ ok: true, value: { scope, session } }); });
          current = archives[input.sessionId];
          return { ok: true, value: { scope, session } };
        }
        if (method === 'dialogue.retry') {
          if (window.failRetry) { window.failRetry = false; return { ok: false, code: 'DIALOGUE_REQUEST_FAILED' }; }
          current.groups.at(-1).answers[0].status = 'completed'; current.revision++;
          return { ok: true, value: { scope, session: structuredClone(current) } };
        }
        if (method === 'dialogue.preferences') { window.modelChoices = input.modelIds; return { ok:true, value:{ scope, visibleModelIds:window.modelChoices } }; }
        if (method === 'dialogue.load') return { ok: true, value: { scope, visibleModelIds:window.modelChoices, capabilities: { model_switch: window.modelSwitchSupport }, models: [
          { id: 'deepseek', name: 'DeepSeek', provider: 'deepseek' }, { id: 'claude', name: 'Claude', provider: 'anthropic' }, { id: 'gemini', name: 'Gemini', provider: 'google', is_local: false },
          { id: 'local-qwen', name: 'Qwen 本机', provider: '任意改名', is_local: true }
        ], sessions: Object.values(archives).map(item => ({ session_id: item.id, title: item.title, updated_at: Date.now()/1000 })) } };
        if (method === 'dialogue.send') {
          current = input.sessionId ? archives[input.sessionId] : null;
          const group = { id: 'group-' + (current?.groups.length || 0), parent_answer: input.answerId || null, prompt: input.prompt,
            answers: input.models.map(model => ({ id: 'answer-' + (current?.groups.length || 0) + '-' + model, model, name: model === 'deepseek' ? 'DeepSeek' : 'Claude', text: '已保留前文。这里是 ' + model + ' 的回答。', status: 'completed' })) };
          current = current ? { ...current, revision: current.revision + 1, groups: [...current.groups, group] } : { id: 'conversation-' + (++nextSession), title: input.prompt, revision: 1, groups: [group] };
          archives[current.id] = current;
          return { ok: true, value: { scope, session: structuredClone(current) } };
        }
        return { ok: true, value: { scope, session: current } };
      } });
      ui.hostState(boxState); ui.visible(true); ui.mount(document.getElementById('host'));
      window.check = (value, message) => { if (!value) throw Error(message); };
      window.until = async predicate => { for (let i=0; i<100; i++) { if (predicate()) return; await new Promise(r=>setTimeout(r,10)); } throw Error('UI timeout: '+predicate.toString()); };
      window.draft = value => { const t=document.querySelector('textarea'); t.value=value; t.dispatchEvent(new Event('input')); };
      window.click = action => Array.from(document.querySelectorAll('[data-chat-action="'+action+'"]')).find(button=>button.getClientRects().length)?.click();
      window.send = () => document.querySelector('form').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}));
      void 0;
    `);
    if (process.env.WANX_AI_DIALOGUE_EVIDENCE) {
      await mkdir(process.env.WANX_AI_DIALOGUE_EVIDENCE, { recursive: true });
      await control.webContents.executeJavaScript(`until(()=>document.querySelectorAll('.ai-model').length===3)`);
      await control.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      await writeFile(process.env.WANX_AI_DIALOGUE_EVIDENCE + '/welcome-layout.png', (await control.webContents.capturePage()).toPNG());
    }
    await control.webContents.executeJavaScript(`(async () => {
      await until(()=>document.querySelectorAll('.ai-model').length===3);
      check(document.querySelectorAll('.ai-model.selected').length===1,'single model must be the default');
      check(!document.querySelector('[data-chat-action="compare"]'),'removed comparison entry is still visible');
      check(!document.querySelector('[data-id="local-qwen"]'),'local models must be excluded from the default model list');
      check(document.querySelector('.ai-welcome h2').textContent.includes('小万'),'personal welcome missing');
      check(document.querySelector('[data-chat-history]').hidden,'history should start collapsed for the brand welcome layout');
      const composer=document.querySelector('.ai-composer').getBoundingClientRect();
      check(composer.width>700,'welcome composer must use the full workspace');
      check(document.querySelector('.ai-welcome-mark').naturalWidth>0,'official welcome mark missing');
      draft('请帮我整理这个想法');
      document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));
      check(!calls.some(c=>c.method==='dialogue.send'),'IME Enter sent a message');
      send(); await until(()=>document.querySelector('.ai-answer-text')?.textContent.includes('deepseek'));
      document.querySelector('[data-id="deepseek"]').click();
      check(document.querySelector('.ai-answer-text')?.textContent.includes('deepseek'),'clicking the current model cleared its conversation');
      window.originalConversation = structuredClone(archives['conversation-1']);
      draft('换个模型，开始新的讨论');
      document.querySelector('[data-id="claude"]').click();
      check(document.querySelector('textarea').value==='换个模型，开始新的讨论','changing models lost the draft');
      check(!document.querySelector('.ai-answer') && document.querySelector('[data-chat-context]').textContent.includes('新的对话'),'model switch did not open a fresh conversation');
      check(document.querySelector('[data-chat-notice]').hidden,'old boxes must not require a model-switch upgrade');
      check(calls.filter(c=>c.method==='dialogue.send').length===1,'switching models dispatched a generation');
      ui.event({type:'snapshot',scope,session:structuredClone(archives['conversation-1'])});
      check(!document.querySelector('.ai-answer'),'old stream replaced the new conversation');
      send(); await until(()=>document.querySelector('.ai-answer-text')?.textContent.includes('claude'));
      const sent = calls.filter(c=>c.method==='dialogue.send');
      check(sent.length===2 && !sent[1].input.sessionId && !sent[1].input.answerId && sent[1].input.models[0]==='claude','new model inherited the previous session or context');
      check(JSON.stringify(archives['conversation-1'])===JSON.stringify(originalConversation),'switching models changed the original history');
      draft('继续刚才的话题'); send(); await until(()=>document.querySelectorAll('.ai-answer').length===2);
      const continued=calls.filter(c=>c.method==='dialogue.send').at(-1).input;
      check(continued.sessionId==='conversation-2' && continued.answerId==='answer-0-claude' && continued.keepModel===true,'same-model follow-up lost its own context');
      draft('还有一个想法'); click('history'); click('history');
      check(document.querySelector('textarea').value==='还有一个想法','history drawer lost draft');
      check(document.documentElement.scrollWidth<=innerWidth,'compact UI overflows horizontally');
      click('history');
      const search=document.querySelector('[data-chat-search]');
      search.value='找不到的历史'; search.dispatchEvent(new Event('input'));
      check(!document.querySelector('[data-chat-action="open"]'),'history search did not filter results');
      search.value=''; search.dispatchEvent(new Event('input'));
      check(document.querySelector('[data-chat-action="open"]'),'clearing history search did not restore results');
      click('history');
      document.querySelector('[data-chat-action="open"][data-id="conversation-1"]').click();
      await until(()=>document.querySelector('.ai-answer-text')?.textContent.includes('deepseek'));
      check(document.querySelector('.ai-model.selected').dataset.id==='deepseek','reopening history did not restore its model');
      window.modelSwitchSupport=1; click('refresh');
      await until(()=>calls.filter(c=>c.method==='dialogue.load').length===2 && !document.querySelector('[data-chat-action="refresh"]').disabled);
      document.querySelector('[data-id="gemini"]').click();
      check(document.querySelectorAll('.ai-model.selected').length===1 && document.querySelector('.ai-model.selected').dataset.id==='gemini','switching models must replace the selected model');
      check(!document.querySelector('.ai-answer'),'capable boxes must also start a new conversation on model switch');
      send(); await until(()=>document.querySelector('.ai-answer-text')?.textContent.includes('gemini'));
      check(calls.filter(c=>c.method==='dialogue.send').every(call=>call.input.models.length===1),'a new turn selected multiple models');
      current.groups.at(-1).answers[0].status='failed'; current.revision++;
      ui.event({type:'snapshot',scope,session:structuredClone(current)});
      window.failRetry=true; click('regenerate');
      await until(()=>document.querySelector('[data-chat-action="confirm"]'));
      check(document.querySelector('[data-chat-action="regenerate"]').disabled,'uncertain retry can be submitted twice');
      click('regenerate');
      check(calls.filter(c=>c.method==='dialogue.retry').length===1,'a second generation was dispatched');
      click('confirm'); await until(()=>!document.querySelector('[data-chat-action="confirm"]'));
      const retries=calls.filter(c=>c.method==='dialogue.retry');
      check(retries.length===2 && retries[0].input.requestId===retries[1].input.requestId,'uncertain retry lost original request id');
    })()`);
    if (process.env.WANX_AI_DIALOGUE_EVIDENCE) {
      await mkdir(process.env.WANX_AI_DIALOGUE_EVIDENCE, { recursive: true });
      await writeFile(process.env.WANX_AI_DIALOGUE_EVIDENCE + '/compact-dialogue.png', (await control.webContents.capturePage()).toPNG());
    }
    await control.webContents.executeJavaScript(`(async()=>{
      window.deferOpen=true; click('history'); document.querySelector('[data-chat-action="open"]').click();
      await until(()=>window.resolveOpen); document.querySelector('[data-id="claude"]').click(); resolveOpen();
      await new Promise(r=>setTimeout(r,20));
      check(!document.querySelector('.ai-answer') && document.querySelector('.ai-model.selected').dataset.id==='claude','late history response replaced the model-switched new conversation');
    })()`);
    control.setSize(640, 620);
    await control.webContents.executeJavaScript(`
      if (!document.querySelector('[data-chat-history]').hidden) click('history');
      check(document.documentElement.scrollWidth<=innerWidth,'narrow layout overflows');
      const c=document.querySelector('.ai-composer').getBoundingClientRect();
      check(c.width>500 && c.right<=innerWidth,'narrow sidebar must collapse without squeezing input');
    `);
    if (process.env.WANX_AI_DIALOGUE_EVIDENCE) await writeFile(process.env.WANX_AI_DIALOGUE_EVIDENCE + '/welcome-narrow.png', (await control.webContents.capturePage()).toPNG());
    await control.webContents.executeJavaScript(`ui.hostState({ account: { phase: 'signed_out' } }); check(!document.body.textContent.includes('已保留前文'),'previous account transcript leaked'); check(document.querySelector('textarea').value==='','previous account draft leaked');`);
    await control.webContents.executeJavaScript(`(async()=>{
      const oldCalls = calls.filter(c=>c.method==='dialogue.send').length;
      ui.hostState(boxState); ui.visible(false);
      document.getElementById('host').hidden=true;
      const settingsHost=document.createElement('main'); settingsHost.id='settings-host'; settingsHost.className='page-content dialogue-model-settings-page'; document.body.append(settingsHost);
      window.modelSettings=createDialogueModelSettingsView({ request:dialogueRequest, onSaved:()=>ui.modelsChanged() });
      modelSettings.hostState(boxState); modelSettings.visible(true); modelSettings.mount(settingsHost);
      await until(()=>document.querySelectorAll('[data-model-choice]').length===3);
      check(!document.querySelector('[data-model-choice="local-qwen"]'),'settings should list available cloud models');
      document.querySelector('[data-model-choice="deepseek"]').click();
      document.querySelector('[data-model-choice="gemini"]').click();
      modelSettings.hostState(structuredClone(boxState));
      check(document.querySelector('[data-model-choice="claude"]').checked && !document.querySelector('[data-model-choice="deepseek"]').checked,'state refresh discarded settings draft');
      document.querySelector('[data-model-settings="save"]').click();
      await until(()=>document.querySelector('[data-model-save-status]')?.textContent.includes('已保存'));
      check(JSON.stringify(modelChoices)==='["claude"]','checked models were not saved');
      modelSettings.visible(false); settingsHost.hidden=true; document.getElementById('host').hidden=false;
      ui.visible(true);
      await until(()=>document.querySelectorAll('#host .ai-model').length===1);
      check(document.querySelector('#host .ai-model').dataset.id==='claude','saved visibility did not update dialogue');
      modelSettings.visible(true); settingsHost.hidden=false; document.getElementById('host').hidden=true; ui.visible(false);
      document.querySelector('[data-model-choice="claude"]').click();
      check(document.querySelector('[data-model-settings="save"]').disabled,'empty selection must be explained before saving');
      document.querySelector('[data-model-settings="reset"]').click();
      document.querySelector('[data-model-settings="save"]').click();
      await until(()=>modelChoices===null && document.querySelector('[data-model-save-status]')?.textContent.includes('已保存'));
      check(document.getElementById('host').hidden && settingsHost.getBoundingClientRect().height>0,'settings page did not become visible');
      scrollTo(0,0); await document.fonts.ready;
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      check(calls.filter(c=>c.method==='dialogue.send').length===oldCalls,'model settings triggered a generation');
    })()`);
    if(process.env.WANX_AI_DIALOGUE_EVIDENCE) await writeFile(process.env.WANX_AI_DIALOGUE_EVIDENCE+'/model-settings.png',(await control.webContents.capturePage()).toPNG());
    if (process.env.WANX_AI_DIALOGUE_EVIDENCE) {
      control.setSize(900, 599);
      await control.webContents.executeJavaScript(`(async()=>{
        document.body.innerHTML='<main id="qa-host" style="height:100vh"></main>';
        window.qa = createAIDialogueView({ onBoxes() {}, request: async method => ({ ok:true, value:{
          scope:'visual-fixture', capabilities:{model_switch:1},
          models:[{id:'flash',name:'DeepSeek V4 Flash',provider:'DeepSeek',is_local:false},{id:'pro',name:'DeepSeek V4 Pro',provider:'DeepSeek',is_local:false}],
          sessions:[{session_id:'sample-a',title:'关于产品方案的讨论',updated_at:1792630800},{session_id:'sample-b',title:'帮我梳理一个写作提纲',updated_at:1792627200}]
        } }) });
        qa.hostState({ ...boxState, account:{...boxState.account,profile:{displayName:'嘉木'}},connection:{...boxState.connection,name:'本机万象'} });
        qa.visible(true); qa.mount(document.getElementById('qa-host'));
        await until(()=>document.querySelectorAll('.ai-model').length===2);
        await document.fonts.ready;
        await Promise.all(Array.from(document.images).map(img=>img.complete?Promise.resolve():new Promise(resolve=>{img.onload=resolve;img.onerror=resolve;})));
        check(Array.from(document.images).every(img=>img.naturalWidth>0),'bundled design asset did not load');
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      })()`);

      await writeFile(process.env.WANX_AI_DIALOGUE_EVIDENCE+'/brand-paper-reference-900.png',(await control.webContents.capturePage()).toPNG());
      await control.webContents.executeJavaScript(`click('history'); const brand=document.querySelector('.ai-sidebar-brand').getBoundingClientRect(); const collapse=document.querySelector('.ai-sidebar-heading button').getBoundingClientRect(); check(brand.right+3<=collapse.left,'sidebar brand overlaps collapse action'); click('history');`);
      control.setSize(640,620);
      await control.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      await writeFile(process.env.WANX_AI_DIALOGUE_EVIDENCE+'/brand-paper-compact-640.png',(await control.webContents.capturePage()).toPNG());
    }
    console.log('AI_DIALOGUE_UI_PASS');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { control?.destroy(); app.exit(process.exitCode || 0); }
}
void verify();
