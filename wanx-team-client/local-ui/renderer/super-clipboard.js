(() => {
  const panelMode=document.body.dataset.noteSurface==='panel';let edge=null;
  const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const icon=name=>`<svg viewBox="0 0 24 24" aria-hidden="true">${({close:'<path d="m6 6 12 12M6 18 18 6"/>',image:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',back:'<path d="m14 5-7 7 7 7"/>',note:'<path d="M5 3h14v18H5zM9 8h6M9 12h6M9 16h4"/>',more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'})[name]||''}</svg>`;
  const messages={CLIPBOARD_IMAGES_ONLY:'这里只接收文字和图片，普通文件请上传到空间。',CLIPBOARD_LIMIT:'一次最多20张图片，单张最大20 MB；本批内容未加入。',CLIPBOARD_NOTE_LIMIT:'便签文字和结构最多1 MB，请精简后继续。',CLIPBOARD_NOTE_BUSY:'请等待当前内容同步完成后再操作。',CLIPBOARD_VIRTUAL_FILE:'请粘贴截图或已保存到本机的图片。',CLIPBOARD_EMPTY:'没有可粘贴的文字或图片。',SPACE_CONTEXT_CHANGED:'账号或盒子已切换，本次操作已停止。',ACCOUNT_LOGIN_REQUIRED:'请先登录并选择盒子。',BOX_CONNECTION_REQUIRED:'请先选择要保存到的盒子。',CLIPBOARD_NOTE_CONFLICT:'其他设备已修改便签，本机草稿已保留。',CLIPBOARD_CACHE_FULL:'本机缓存已满，请先完成图片同步。',SECURE_STORAGE_WRITE_FAILED:'本机草稿保存失败，请保持窗口打开后重试。',CLIPBOARD_QUOTA:'盒子便签空间不足，本机草稿仍保留。'};
  let host=null,state={items:[],tasks:[]},container=null,opened=false,active=false,poll=null,closeTimer=null,writing=Promise.resolve(),localEdits=0,renderedScope=null,rendered='',composing=false,selection=null,error='',returnFocus=null;
  const urls=new Map(),imageLoads=new Set();let lastPersist='',modalAction=null,contextGeneration=0;
  const message=e=>messages[e.code||e.message]||'暂未同步到盒子，本机草稿会保留并自动重试。';
  const editor=()=>container?.querySelector('.clipboard-note-editor');
  const boxName=()=>host?.devices?.find(d=>d.deviceId===state.boxId)?.displayName||host?.connection?.name||'上次连接的盒子';
  async function call(method,input={}){const scope=state.scope,generation=contextGeneration,r=await window.wanxClient.action('clipboard.'+method,{...input,scope});if(!r.ok)throw Object.assign(Error(r.code),{code:r.code});if(scope!==state.scope||generation!==contextGeneration)throw Object.assign(Error('SPACE_CONTEXT_CHANGED'),{code:'SPACE_CONTEXT_CHANGED'});return r.value;}
  function blocks(){
    const output=[];let text='';
    const flush=()=>{if(text){output.push({type:'text',text});text='';}};
    const isLine=node=>node?.nodeType===1&&['DIV','P'].includes(node.tagName);
    const walk=node=>{
      const previous=node.previousSibling;
      if(previous&&(isLine(node)||isLine(previous))&&previous.nodeName!=='BR'&&previous.nodeName!=='FIGURE')text+='\n';
      if(node.nodeType===3){text+=node.textContent;return;}
      if(node.nodeType!==1)return;
      if(node.matches('figure[data-item]')){flush();output.push({type:'image',item:node.dataset.item});return;}
      if(node.tagName==='BR'){
        // Chromium adds a terminal BR as a caret placeholder, not another text line.
        if(!node.nextSibling&&(!previous||['BR','FIGURE'].includes(previous.nodeName)))return;
        text+='\n';return;
      }
      for(const child of node.childNodes)walk(child);
    };
    for(const child of editor().childNodes)walk(child);flush();
    // Chromium leaves a lone BR in an otherwise empty editor.
    if(output.length===1&&output[0].type==='text'&&output[0].text==='\n'&&editor().textContent==='')return [];
    return output;
  }
  function rememberSelection(){const s=window.getSelection();if(s?.rangeCount&&editor()?.contains(s.anchorNode))selection=s.getRangeAt(0).cloneRange();}
  function placeSelection(){const e=editor();e.focus({preventScroll:true});const s=window.getSelection();if(selection&&e.contains(selection.startContainer)){s.removeAllRanges();s.addRange(selection);}else{const r=document.createRange();r.selectNodeContents(e);r.collapse(false);s.removeAllRanges();s.addRange(r);}}
  function persistEditor(force=false){
    if(!editor()||!state.scope)return writing;
    const value=blocks(),tag=JSON.stringify(value),bound=state.scope;
    if(!force&&tag===lastPersist)return writing;lastPersist=tag;localEdits++;
    writing=writing.catch(()=>{}).then(async()=>{
      try{if(bound!==state.scope)return;const next=await call('note-save',{blocks:value});if(bound===state.scope){state=next;error='';}}
      catch(e){if(bound===state.scope){error=message(e);lastPersist='';}}
      finally{localEdits--;paint(false);}
    });return writing;
  }
  async function loadImages(){
    for(const img of editor()?.querySelectorAll('img[data-item]')||[]){const id=img.dataset.item;if(urls.has(id)){img.src=urls.get(id);img.alt='便签图片';img.closest('figure').classList.add('is-ready');continue;}if(imageLoads.has(id))continue;imageLoads.add(id);
      try{const bound=state.scope,r=await call('preview',{id});if(bound!==state.scope)continue;const url=URL.createObjectURL(new Blob([Uint8Array.from(atob(r.data),c=>c.charCodeAt(0))],{type:r.item.mime}));urls.set(id,url);img.src=url;img.alt=r.item.name||'图片';img.closest('figure').classList.add('is-ready');}catch{}finally{imageLoads.delete(id);}
    }
  }
  function renderNote(){
    const e=editor(),note=state.note;if(!e||!note)return;
    const content=JSON.stringify(note.blocks||[]),sameScope=renderedScope===state.scope;
    if(sameScope&&(composing||localEdits))return;
    if(sameScope&&JSON.stringify(blocks())===content){rendered=content;void loadImages();return;}
    if(sameScope&&content===rendered)return;
    if(sameScope&&document.hasFocus()&&document.activeElement===e&&JSON.stringify(blocks())!==content&&note.phase!=='saved')return;
    const focused=document.activeElement===e;e.replaceChildren();
    for(const b of note.blocks||[]){if(b.type==='text')e.append(document.createTextNode(b.text));else{const f=document.createElement('figure');f.contentEditable='false';f.dataset.item=b.item;f.innerHTML=`<img data-item="${b.item}" alt="图片正在准备"><span>图片</span>`;e.append(f);}}
    if(e.lastChild?.nodeName==='FIGURE')e.append(document.createElement('br'));
    renderedScope=state.scope;rendered=content;lastPersist=content;selection=null;
    if(focused){const r=document.createRange();r.selectNodeContents(e);r.collapse(false);const s=window.getSelection();s.removeAllRanges();s.addRange(r);}
    void loadImages();
  }
  function update(next){
    if(host?.dataIdentity?.profileId&&(!host.dataOwnerId||next.dataOwnerId!==host.dataOwnerId||next.dataContextId!==host.dataContextId))return;
    if(next.scope!==state.scope){for(const u of urls.values())URL.revokeObjectURL(u);urls.clear();selection=null;renderedScope=null;lastPersist='';error='';if(editor())editor().replaceChildren();}
    if(next.note?.phase==='saved'&&error===message({code:'ECONNREFUSED'}))error='';
    state=next;paint();
  }
  function paint(render=true){
    if(!container||!opened)return;
    if(render)renderNote();
    const n=state.note||{};
    container.querySelector('.clipboard-connection').textContent=boxName()+' · 共享便签';
    container.querySelector('.clipboard-connection').classList.toggle('is-online',!!state.online);
    const status=container.querySelector('.clipboard-note-status');
    status.textContent=localEdits?'正在保存到本机…':error===messages.SECURE_STORAGE_WRITE_FAILED?'本机保存失败，请重试':n.phase==='locked'?'请先登录并选择盒子':n.phase==='conflict'?'本机草稿已保留 · 有版本冲突':n.revision===null&&!n.dirty&&!n.pending?'等待读取盒子便签':n.phase==='offline'?'已保存到本机 · 等待连接':n.phase==='syncing'?n.error?'已保存到本机 · 正在重试同步':'已保存到本机 · 正在同步':state.online?'已同步到盒子':'已保存到本机';
    const notice=container.querySelector('.clipboard-note-error');notice.textContent=error||n.error&&n.error!=='CLIPBOARD_NOTE_CONFLICT'?error||message({code:n.error}):'';
    container.querySelector('.clipboard-note-conflict').hidden=!n.conflict;
    container.querySelector('[data-clip="restore"]').hidden=!n.has_backup;
    container.querySelector('[data-clip="recover-local"]').hidden=!n.recovery;
    editor().contentEditable=state.scope?'true':'false';
    container.querySelector('.clipboard-note-transfers').innerHTML=(state.tasks||[]).filter(t=>t.kind==='image').map(t=>`<div class="clipboard-note-transfer"><span title="${esc(t.name)}">${esc(t.name)}</span><small>${t.phase==='paused'?'已暂停':t.phase==='failed'?'同步失败':Math.floor((t.offset||0)/Math.max(1,t.size)*100)+'%'}</small><button data-clip="${['paused','failed'].includes(t.phase)?'resume':'pause'}" data-id="${t.id}">${['paused','failed'].includes(t.phase)?'继续':'暂停'}</button><progress value="${t.offset||0}" max="${t.size||1}"></progress></div>`).join('');
    const hasText=blocks().some(b=>b.type==='text'&&b.text.length);editor().classList.toggle('is-empty',!hasText&&!editor().querySelector('figure'));
  }
  function insertText(text){placeSelection();document.execCommand('insertText',false,text);rememberSelection();void persistEditor();}
  async function insertImages(run){
    rememberSelection();const bound=state.scope;
    try{const r=await run();if(bound!==state.scope)return;if(!r)return;state=r;
      if(typeof r.text==='string'){insertText(r.text);return;}
      const images=(r.captured||[]).filter(i=>i.kind==='image');if(!images.length)return;
      placeSelection();document.execCommand('insertHTML',false,images.map(i=>`<figure contenteditable="false" data-item="${i.id}"><img data-item="${i.id}" alt="${esc(i.name)}"><span>图片</span></figure>`).join('')+'<br>');const last=editor().querySelector(`figure[data-item="${images.at(-1).id}"]`);if(last){const paragraph=document.createElement('div');paragraph.append(document.createElement('br'));if(last.nextSibling?.nodeName==='BR')last.nextSibling.replaceWith(paragraph);else last.after(paragraph);const range=document.createRange();range.setStart(paragraph,0);range.collapse(true);const selected=window.getSelection();selected.removeAllRanges();selected.addRange(range);}rememberSelection();await persistEditor();await loadImages();error='';
    }catch(e){error=message(e);}paint(false);
  }
  async function paste(event){
    if(event){event.preventDefault();event.stopPropagation();const files=Array.from(event.clipboardData?.files||[]);
      if(files.length)return insertImages(async()=>{const r=await window.wanxClient.clipboardFiles(files,{scope:state.scope});if(!r.ok)throw Object.assign(Error(r.code),{code:r.code});return r.value;});
      const text=event.clipboardData?.getData('text/plain');if(text&&!Array.from(event.clipboardData?.types||[]).includes('text/uri-list'))return insertText(text);
    }
    // OS-native paste is needed for copied Finder/Explorer images and screenshots.
    return insertImages(()=>call('note-paste'));
  }
  function confirmAction(action,text){modalAction=action;container.querySelector('.clipboard-note-modal').innerHTML=`<div class="clipboard-modal-shade"><section role="dialog" aria-modal="true"><h3>${text}</h3><p>当前内容会保留，可在更多菜单中恢复。</p><button class="button primary" data-clip="confirm">确定</button><button class="text-button" data-clip="cancel-dialog">取消</button></section></div>`;}
  async function action(action,button){
    error='';container.querySelector('details').open=false;
    if(action==='close')return toggle();
    if(action==='choose')return insertImages(()=>call('choose'));
    if(action==='pause'||action==='resume'){update(await call('transfer',{id:button.dataset.id,action}));return;}
    if(action==='clear')return confirmAction('clear','清空这张共享便签？');
    if(action==='local')return confirmAction('local','用本机草稿替换盒子内容？');
    if(action==='cancel-dialog'){container.querySelector('.clipboard-note-modal').replaceChildren();modalAction=null;return;}
    if(action==='confirm'){action=modalAction;modalAction=null;container.querySelector('.clipboard-note-modal').replaceChildren();}
    if(['clear','restore','remote','local','recover-local'].includes(action)){
      await persistEditor();update(await call('note-command',{action}));renderedScope=null;renderNote();
    }
    if(action==='legacy'){
      const old=await call('refresh');container.querySelector('.clipboard-note-modal').innerHTML=`<div class="clipboard-modal-shade"><section role="dialog" aria-modal="true"><h3>旧版内容</h3><p>旧版内容仍然保留，可下载后使用。</p>${old.items.map(i=>`<button class="text-button" data-clip="legacy-download" data-id="${i.id}">${esc(i.name)}</button>`).join('')||'<p>没有旧版内容</p>'}<button class="text-button" data-clip="cancel-dialog">关闭</button></section></div>`;
    }
    if(action==='legacy-download')await call('download',{id:button.dataset.id});
  }
  async function refresh(){if(!opened||composing||localEdits||editor()?.contains(document.activeElement))return;try{update(await call('note-refresh'));error='';paint(false);}catch(e){error=message(e);paint(false);}}
  function reflect(){
    if(!panelMode&&active&&!edge){
      edge=document.createElement('button');edge.className='note-edge';edge.dataset.action='clipboard-toggle';edge.setAttribute('aria-label','打开便签');edge.title='便签';edge.innerHTML=icon('note')+'<span>便签</span>';document.body.append(edge);
    }
    if(edge){edge.hidden=!active||opened;edge.setAttribute('aria-expanded',String(opened));edge.setAttribute('aria-controls','super-clipboard');}
    if(panelMode)window.dispatchEvent(new CustomEvent('wanx-note-view',{detail:{opened}}));
    if(!container)return;for(const b of document.querySelectorAll('[data-action="clipboard-toggle"]')){b.setAttribute('aria-expanded',String(opened));b.setAttribute('aria-controls','super-clipboard');b.classList.toggle('clipboard-trigger-active',opened);}}
  function position(){if(container&&opened&&!panelMode)container.style.top=`${Math.max(0,document.querySelector('.topbar')?.getBoundingClientRect().bottom||0)+10}px`;}
  function mount(){
    if(container)return;container=document.createElement('aside');container.id='super-clipboard';container.className='clipboard-drawer clipboard-notepad'+(panelMode?' clipboard-panel-note':'');container.hidden=true;container.inert=true;container.setAttribute('aria-label','共享图文便签');
    container.innerHTML=`<header class="clipboard-header"><div class="clipboard-title">${panelMode?'<button class="note-back" data-clip="close" aria-label="返回我的应用">'+icon('back')+'<span>应用</span></button>':''}<div><h2>便签</h2><p class="clipboard-connection"></p></div></div><div class="clipboard-header-actions"><button class="clipboard-icon-button" data-clip="choose" title="插入图片" aria-label="插入图片">${icon('image')}</button><details class="clipboard-note-menu"><summary class="clipboard-icon-button" aria-label="更多便签操作">${icon('more')}</summary><div><button data-clip="clear">清空便签…</button><button data-clip="restore" hidden>恢复清空前内容</button><button data-clip="recover-local" hidden>恢复本机保留稿</button>${panelMode?'':'<button data-clip="legacy">旧版内容</button>'}</div></details><button class="clipboard-icon-button" data-clip="close" title="收起 · Esc" aria-label="关闭便签">${icon('close')}</button></div></header><div class="clipboard-note-conflict" hidden><p>其他设备已修改便签。本机草稿已保留，请选择要继续编辑的版本。</p><button data-clip="remote">使用盒子内容</button><button data-clip="local">使用本机草稿…</button></div><div class="clipboard-note-scroll"><div class="clipboard-note-editor is-empty" role="textbox" aria-label="共享图文便签内容" aria-multiline="true" contenteditable="true" spellcheck="false" data-placeholder="在这里写点什么，或粘贴文字、图片…"></div></div><footer class="clipboard-note-footer"><div class="clipboard-note-transfers"></div><p class="clipboard-note-error" role="status"></p><div><span class="clipboard-note-status" aria-live="polite"></span><span title="同账号、同盒子的已审批 Agent 可读取这张共享便签">Agent 可读</span></div></footer><div class="clipboard-note-modal"></div>`;
    (panelMode?document.querySelector('#panel'):document.body).append(container);const e=editor();
    e.addEventListener('input',()=>{rememberSelection();void persistEditor();paint(false);});
    e.addEventListener('compositionstart',()=>{composing=true;});e.addEventListener('compositionend',()=>{composing=false;void persistEditor(true);});
    e.addEventListener('keyup',rememberSelection);e.addEventListener('mouseup',rememberSelection);e.addEventListener('blur',()=>{rememberSelection();void persistEditor();});
    e.addEventListener('paste',event=>void paste(event));
    container.addEventListener('mousedown',event=>{if(event.target.closest('.clipboard-header-actions'))rememberSelection();});
    container.addEventListener('click',event=>{const b=event.target.closest('[data-clip]');if(!b)return;event.preventDefault();event.stopPropagation();void action(b.dataset.clip,b).catch(e=>{error=message(e);paint(false);});});
    e.addEventListener('dragover',event=>{event.preventDefault();event.stopPropagation();});
    e.addEventListener('drop',event=>{event.preventDefault();event.stopPropagation();const range=document.caretRangeFromPoint?.(event.clientX,event.clientY);if(range&&e.contains(range.startContainer))selection=range;
      const files=Array.from(event.dataTransfer?.files||[]);if(files.length)void insertImages(async()=>{const r=await window.wanxClient.clipboardFiles(files,{scope:state.scope});if(!r.ok)throw Object.assign(Error(r.code),{code:r.code});return r.value;});else{const text=event.dataTransfer?.getData('text/plain');if(text)insertText(text);}
    });
  }
  async function toggle(value){
    const next=typeof value==='boolean'?value:!opened;if(next===opened)return;
    mount();if(opened)await persistEditor();opened=next;if(panelMode&&!opened)container.hidden=true;clearTimeout(closeTimer);reflect();
    if(opened){
      returnFocus=document.activeElement;container.hidden=false;container.inert=false;position();container.getBoundingClientRect();requestAnimationFrame(()=>{if(opened)container.classList.add('is-open');});
      try{update(await call('snapshot'));const next=await call('note-refresh');update(next);}catch(e){error=message(e);paint();}
      if(!opened)return;editor().focus({preventScroll:true});if(selection)placeSelection();poll=setInterval(()=>void refresh(),3000);
    }else{clearInterval(poll);container.inert=true;container.classList.remove('is-open');if(container.contains(document.activeElement))returnFocus?.focus({preventScroll:true});closeTimer=setTimeout(()=>{if(!opened)container.hidden=true;},220);}
  }
  document.addEventListener('click',event=>{if(event.target.closest('[data-action="clipboard-toggle"]')){event.preventDefault();event.stopPropagation();void toggle().catch(e=>{error=message(e);paint(false);});}else if(opened&&!panelMode&&!container.contains(event.target)&&!composing){void toggle(false).catch(e=>{error=message(e);paint(false);});}},true);
  document.addEventListener('keydown',event=>{if(opened&&event.key==='Escape'&&!event.isComposing){event.preventDefault();event.stopImmediatePropagation();if(container.querySelector('.clipboard-note-modal').hasChildNodes()){modalAction=null;container.querySelector('.clipboard-note-modal').replaceChildren();}else void toggle();}},true);
  window.addEventListener?.('resize',position);window.wanxClient.onClipboardState?.(update);
  window.wanxClipboard={hostState(next){const changed=host&&(next.dataIdentity?.profileId||host.dataIdentity?.profileId?next.dataContextId!==host.dataContextId:next.account?.accountId!==host.account?.accountId);if(changed||next.route==='auth'){contextGeneration++;selection=null;opened=false;composing=false;clearInterval(poll);clearTimeout(closeTimer);for(const url of urls.values())URL.revokeObjectURL(url);urls.clear();state={items:[],tasks:[],scope:null};renderedScope=null;rendered='';lastPersist='';modalAction=null;if(container){container.hidden=true;container.inert=true;container.classList.remove('is-open');editor()?.replaceChildren();container.querySelector('.clipboard-note-modal')?.replaceChildren();}}host=next;reflect();},setActive(value){active=value;if(!active&&opened)void toggle(false);reflect();},toggle};
})();
