(() => {
  const esc = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
  const personal = () => ({id:'personal',name:'我的空间',root:'',connections:[]});
  const label = {active:'已连接',paused:'已暂停',disconnected:'已断开',pending:'待确认',rejected:'已拒绝'};
  const bytes = n => n > 1048576 ? `${(n/1048576).toFixed(1)} MB` : `${((n || 0)/1024).toFixed(1)} KB`;
  let options, spaces=[personal()], requests=[], favorites=[], cache=new Map(), expanded=new Set(), key='', epoch=0, modal=null, composing=false;
  let position={space:'personal',parent:'',trash:false}, history=[], index=-1;
  const current = () => spaces.find(s=>s.id===position.space) || personal();
  const nodeKey = (space,id) => `${space}:${id}`;
  const call = async (method,input={}) => { const before=epoch; const result=await options.call(method,input); if(before!==epoch)throw new Error('SPACE_CONTEXT_CHANGED');return result; };
  const manage = (method,input) => call(`links-${method}`,input);
  const button = (text,action,data='') => `<button class="button small" data-workspace-action="${action}" ${data}>${esc(text)}</button>`;
  const save = () => { try { localStorage.setItem(key,JSON.stringify(favorites.map(({space,id})=>({space,id})))); } catch { /* Storage can be unavailable; this session still works. */ } };
  function storageScope(scope) {
    const next=`wanx-space-favorites:${scope}`; if(key===next)return;key=next;
    try { favorites=JSON.parse(localStorage.getItem(key) || "[]").filter(f=>typeof f.space==="string"&&typeof f.id==="string").slice(0,100); } catch { favorites=[]; }
  }
  function reset(scope) {
    epoch++; key=`wanx-space-favorites:${(window.location?.origin || "local")}:${scope || ''}`; spaces=[personal()];requests=[];cache.clear();expanded.clear();modal=null;composing=false;
    position={space:'personal',parent:'',trash:false};history=[];index=-1;
    try { favorites=JSON.parse(localStorage.getItem(key) || '[]').filter(f=>typeof f.space==='string'&&typeof f.id==='string').slice(0,100); } catch {favorites=[];}
  }
  async function refresh() {
    const before=epoch;
    try { const result=await manage('spaces'); if(Array.isArray(result)) spaces=result; requests=await manage('requests'); }
    catch(error) { if(before!==epoch)throw error; if(!String(error.message).includes('UPGRADE')&&!String(error.message).includes('404'))throw error; }
    cache.clear();
    await Promise.all([...expanded].map(async k=>{const [space,id]=k.split(':');if(!spaces.some(s=>s.id===space&&!s.trashed)){expanded.delete(k);return;}try{await children(space,id);}catch(error){if(before!==epoch)throw error;expanded.delete(k);}}));
    const resolved=await Promise.all(favorites.map(async f=>{
      const space=spaces.find(s=>s.id===f.space);
      if(space && f.id===space.root)return {...f,name:space.name,unavailable:Boolean(space.trashed)};
      try { const item=await call('stat',{id:f.id});return {...f,space:item.space_id || 'personal',name:item.name,unavailable:false}; }
      catch(error) { if(before!==epoch)throw error;return {...f,name:f.name || '位置暂不可用',unavailable:true}; }
    }));
    if(before!==epoch)return;
    favorites=resolved; save();
  }
  async function children(space,id) {
    const k=nodeKey(space,id);
    if(!cache.has(k)) { const data=await call('list',{parent:id,space_id:space});cache.set(k,data.items.filter(i=>i.kind==='folder')); }
    return cache.get(k);
  }
  async function observe(next,listing,record=true) {
    position={...next};
    const space=current();
    if(!next.trash) {
      cache.set(nodeKey(next.space,next.parent),listing.items.filter(i=>i.kind==='folder'));
      for(const id of [space.root,...listing.breadcrumbs.map(c=>c.id)]) expanded.add(nodeKey(next.space,id));
      await Promise.all([space.root,...listing.breadcrumbs.map(c=>c.id)].map(id=>children(next.space,id)));
    }
    if(record && JSON.stringify(history[index])!==JSON.stringify(position)) { history=history.slice(0,index+1);history.push({...position});index=history.length-1; }
  }
  function tree(space,id,name,depth=0) {
    const k=nodeKey(space,id),open=expanded.has(k),selected=!position.trash&&position.space===space&&position.parent===id;
    const data=`data-id="${esc(id)}" data-space="${esc(space)}" data-name="${esc(name)}"`;
    return `<div class="space-tree-node" style="--depth:${depth}"><button class="space-tree-toggle" data-workspace-action="expand" ${data} aria-label="${open?'折叠':'展开'}${esc(name)}" aria-expanded="${open}">${open?'▾':'▸'}</button><button class="space-nav ${selected?'active':''}" data-action="space-folder" ${data} ${selected?'aria-current="page"':''}><span aria-hidden="true">${depth?'▱':'▣'}</span><span>${esc(name)}</span></button>${!depth?`<button class="space-tree-more" data-workspace-action="manage" data-space="${space}" aria-label="管理${esc(name)}">⋯</button>`:''}</div>${open&&depth<40?(cache.get(k)||[]).map(c=>tree(space,c.id,c.name,depth+1)).join(''):''}`;
  }
  function sidebar() {
    const own=spaces.find(s=>s.id==='personal') || personal();
    return `<div class="space-tree">${tree(own.id,own.root,'我的空间')}<div class="space-sidebar-caption">常用位置</div>${favorites.map(f=>`<div class="space-favorite"><button class="space-nav" data-action="space-folder" data-id="${esc(f.id)}" data-space="${esc(f.space)}" data-name="${esc(f.name)}" ${f.unavailable?'disabled':''}>☆ <span>${esc(f.name || '正在读取…')}</span></button><button class="space-tree-more" data-workspace-action="unpin" data-id="${esc(f.id)}" data-space="${esc(f.space)}" aria-label="取消固定">×</button></div>`).join('') || '<p class="space-sidebar-note">右键文件夹可固定</p>'}<div class="space-sidebar-caption space-source-heading"><span>来源</span><button class="text-button" data-workspace-action="requests">接入${requests.filter(r=>r.status==='pending').length?` · ${requests.filter(r=>r.status==='pending').length}`:' ＋'}</button></div>${spaces.filter(s=>s.id!=='personal'&&!s.trashed).map(s=>tree(s.id,s.root,s.name)).join('') || '<p class="space-sidebar-note">接入 Agent 后显示独立空间</p>'}<button class="space-nav ${position.trash?'active':''}" data-action="space-recycle">♲ 回收站</button></div>`;
  }
  function navigation() {return `<button class="space-icon-button" data-workspace-action="back" aria-label="后退" ${index<=0?'disabled':''}>←</button><button class="space-icon-button" data-workspace-action="forward" aria-label="前进" ${index>=history.length-1?'disabled':''}>→</button>`;}
  function storageView() {
    if(position.trash)return '';
    const space=current(),location=space.storage;
    return `<div class="space-storage-location"><div><small>存储位置 · 万象主机</small><button class="text-button" data-workspace-action="storage" data-space="${esc(space.id)}" aria-label="设置当前空间存储目录">设置</button></div><span title="${esc(location?.directory || '')}">${esc(location?.path || '默认位置')}</span>${location?.available===false?'<small class="danger-text">目录暂不可用</small>':''}</div>`;
  }
  function recycled() { return spaces.filter(s=>s.trashed).map(s=>`<div class="space-recycled"><strong>${esc(s.name)}</strong><span>空间 · ${bytes(s.bytes+s.pending_bytes)}</span>${button('恢复空间','restore',`data-space="${s.id}"`)}</div>`).join(''); }
  function setModal(value) { modal=value; composing=false;options.render();const input=document.querySelector('#workspace-name');input?.focus();input?.select(); }
  function close() {modal=null;composing=false;options.render();}
  async function showSpace(id) {
    await refresh();const space=spaces.find(s=>s.id===id);if(!space)return;
    const connections=await Promise.all(space.connections.map(async c=>({...c,grants:await manage('grants',{id:c.id})})));
    setModal({kind:'manage',title:space.name,space,connections});
  }
  function dialogView() {
    if(!modal)return '';
    let body='';const m=modal;
    if(m.kind==='requests') body=`<p>每份配置对应一个独立身份。复制同一配置会共享接入和空间。软件名称仅供参考。</p>${button('生成新的 MCP 配置','config')}<div class="space-links-list">${requests.map(r=>`<article class="space-link-card"><strong>${esc(r.name)}</strong><small>${label[r.status]} · 身份 ${esc(r.profile.slice(0,10))}</small>${r.status!=='rejected'?button(r.status==='pending'?'确认接入…':'重新接入…','approve-form',`data-id="${r.id}"`):''}${r.status==='pending'?button('拒绝','reject',`data-id="${r.id}"`):''}</article>`).join('')||'<p class="muted">尚无接入申请。先将配置加入 Agent，再连接 MCP。</p>'}</div>`;
    if(['approve','rename'].includes(m.kind)) body=`<form data-workspace-form><label for="workspace-name">${m.kind==='approve'?'来源名称':'空间名称'}</label><input id="workspace-name" data-editor-key="${m.kind}:${m.id}" name="name" value="${esc(m.name)}" required maxlength="80" autocomplete="off">${m.kind==='approve'?`<label for="workspace-reconnect">保存位置</label><select id="workspace-reconnect"><option value="">创建独立空间</option>${spaces.filter(s=>s.id!=='personal'&&!s.trashed&&s.connections.every(c=>c.state==='disconnected')).map(s=>`<option value="${s.id}" ${m.space_id===s.id?'selected':''}>关联原空间：${esc(s.name)}</option>`).join('')}</select><p class="muted">确认后，此身份可读写自己的空间。其他空间需要单独授权。</p>`:''}<button class="button primary" type="submit">${m.kind==='approve'?'确认接入':'保存'}</button></form>`;
    if(m.kind==='storage') body=`<p>为“${esc(m.space.name)}”设置文件保存位置。</p><p class="muted space-storage-current" title="${esc(m.space.storage?.directory || '')}">当前位置：${esc(m.space.storage?.path || '默认位置')}</p><form data-workspace-form><div class="space-directory-selection"><span aria-hidden="true">▱</span><div><small>保存到 · 万象主机</small><strong data-storage-path title="${esc(m.path)}">${esc(m.path || '默认位置')}</strong></div>${button(m.choosing?'正在打开…':'选择文件夹…','storage-choose')}</div><div class="market-actions">${button('使用默认位置','storage-default')}</div>${m.browse?`<div class="space-directory-browser" aria-label="万象主机文件夹"><div class="space-directory-heading">${button('返回上级','storage-browse',`data-path="${esc(m.browse.parent)}" ${m.browse.path===m.browse.root?'disabled':''}`)}<span title="${esc(m.browse.path)}">${esc(m.browse.path)}</span></div><div class="space-directory-folders">${m.browse.entries.map(d=>button('▱ '+d.name,'storage-browse',`data-path="${esc(d.path)}"`)).join('')||'<p class="muted">没有子文件夹</p>'}</div><div class="market-actions">${button('选择此文件夹','storage-select')}${button('取消选择','storage-cancel')}</div></div>`:''}<p class="muted">万象会在所选位置建立专用子目录，迁移现有文件、保留版本和回收站内容。选择后点击“迁移并保存”才会更改位置。</p><button class="button primary" type="submit" ${!m.changed||m.browse||m.choosing?'disabled':''}>迁移并保存</button></form><p class="muted" data-storage-progress ${m.saving?'':'hidden'}>正在迁移并校验文件，请稍候…</p>`;
    if(m.kind==='info') body=`<pre class="space-text-preview">${esc(m.text)}</pre>${button('复制','copy-info')}`;
    if(m.kind==='manage') body=`<p>用量 ${bytes(m.space.bytes+m.space.pending_bytes)}<small class="muted"> · 包含上一版本、回收站及未完成上传</small></p><div class="market-actions">${m.space.id!=='personal'?button('重命名','rename',`data-space="${m.space.id}"`):''}${button('固定到常用位置','pin',`data-space="${m.space.id}" data-id="${m.space.root}" data-name="${esc(m.space.name)}"`)}${m.space.id!=='personal'?button('移入回收站…','trash-confirm',`data-space="${m.space.id}"`):''}</div>${m.connections.map(c=>`<article class="space-link-card"><strong>${esc(c.name)} · ${label[c.state]}</strong><small>接入身份 ${esc(c.id)}<br>最近使用：${c.last_used?new Date(c.last_used*1000).toLocaleString():'尚未使用'}</small><div class="market-actions">${c.state!=='disconnected'?button(c.state==='paused'?'恢复接入':'暂停接入','connection',`data-id="${c.id}" data-command="${c.state==='paused'?'resume':'pause'}"`)+button('断开接入…','disconnect-confirm',`data-id="${c.id}"`):''}${button('最近操作','audit',`data-id="${c.id}"`)}</div><h4>额外读写授权</h4><p class="muted">在文件或文件夹的右键菜单中添加授权。</p>${c.grants.filter(g=>!g.revoked).map(g=>`<div class="space-grant"><span>${esc(g.name || '资源已删除')} · ${g.kind==='folder'?'含子目录':'文件'}</span>${button('撤销','revoke',`data-id="${c.id}" data-grant="${g.id}"`)}</div>`).join('')||'<small>没有额外授权</small>'}</article>`).join('')||'<p class="muted">我的空间由你管理。Agent 仅能访问明确授予的资源。</p>'}`;
    if(m.kind==='grant') body=`<p>允许所选身份读写“${esc(m.item.name)}”${m.item.kind==='folder'?'及所有后代目录和新增文件':''}。</p><div class="space-links-list">${spaces.flatMap(s=>s.connections.filter(c=>c.state!=='disconnected').map(c=>`<article class="space-link-card"><strong>${esc(c.name)}</strong><small>${esc(s.name)} · 身份 ${c.id.slice(0,10)}</small>${button('授予读写权限','grant-save',`data-id="${c.id}"`)}</article>`)).join('')||'<p>请先确认一个 Agent 接入。</p>'}</div>`;
    if(m.kind==='confirm') body=`<p>${esc(m.text)}</p>${button('确认','confirm')}`;
    if(m.kind==='storage'&&(m.saving||m.choosing))body=body.replaceAll('<button ', '<button disabled ');
    return `<section class="market-confirmation" role="dialog" aria-modal="true" aria-labelledby="workspace-dialog-title"><div class="market-confirm-card space-dialog"><h2 id="workspace-dialog-title">${esc(m.title)}</h2>${body}<p class="inline-error" data-workspace-error ${m.error?'':'hidden'}>${esc(m.error || '')}</p><div class="market-actions">${button('关闭','close')}</div></div></section>`;
  }
  function retainEditor() {
    if(!modal||!['approve','rename'].includes(modal.kind))return false;
    const input=document.querySelector('#workspace-name');if(input?.dataset.editorKey!==`${modal.kind}:${modal.id}`)return false;
    const notice=document.querySelector('[data-workspace-error]');if(notice){notice.textContent=modal.error || '';notice.hidden=!modal.error;}
    const progress=document.querySelector('[data-storage-progress]');if(progress)progress.hidden=!modal.saving;
    input.disabled=Boolean(modal.saving);
    for(const b of document.querySelectorAll('.space-dialog button'))b.disabled=Boolean(modal.saving);
    return true;
  }
  async function submit() {
    const m=modal;if(!m||m.saving||m.choosing||composing||(m.kind==='storage'&&(!m.changed||m.browse)))return;
    m.saving=true;options.render();
    try { const result=await manage(m.kind==='storage'?'storage-set':m.kind==='approve'?'approve':'space-manage',m.kind==='storage'?{id:m.id,path:m.path}:m.kind==='approve'?{id:m.id,name:m.name,space_id:m.space_id}:{id:m.id,action:'rename',name:m.name});if(modal!==m)return;close();await options.reload();if(result?.cleanup_pending)options.error('迁移已完成，部分旧副本暂未清理。新位置中的文件可正常使用。'); }
    catch(error){if(modal===m)m.error=options.message(error);}finally{m.saving=false;options.render();}
  }
  async function handle(action,data) {
    if(action==='close'){close();return;}
    if(action==='expand'){const k=nodeKey(data.space,data.id);if(expanded.has(k))expanded.delete(k);else{await children(data.space,data.id);expanded.add(k);}return;}
    if(action==='back'||action==='forward'){index+=action==='back'?-1:1;index=Math.max(0,Math.min(history.length-1,index));const p=history[index];if(p)await options.navigate(p.parent,p.trash,p.space,false);return;}
    if(action==='requests'){await refresh();setModal({kind:'requests',title:'Agent 接入'});return;}
    if(action==='config'){setModal({kind:'info',title:'通用 MCP 接入配置',text:JSON.stringify(await manage('agent-config'),null,2)});return;}
    if(action==='copy-info'){await navigator.clipboard.writeText(modal.text);return;}
    if(action==='approve-form'){const r=requests.find(r=>r.id===data.id);if(r)setModal({kind:'approve',id:r.id,title:'确认来源与空间',name:r.name,space_id:r.status==='disconnected'?r.space_id:''});return;}
    if(action==='reject'){await manage('reject',{id:data.id});await refresh();return;}
    if(action==='manage'){await showSpace(data.space);return;}
    if(action==='storage'){await refresh();const s=spaces.find(s=>s.id===data.space);if(s)setModal({kind:'storage',id:s.id,title:'设置空间存储目录',space:s,path:s.storage?.path || '',changed:false});return;}
    if(action==='storage-choose'||action==='storage-browse') {
      const m=modal;if(m?.kind!=='storage'||m.choosing)return;
      m.choosing=true;m.error='';options.render();
      try {
        const selected=await manage('storage-choose',action==='storage-browse'?{path:data.path}:{});
        if(modal!==m)return;
        if(selected.browse)m.browse=selected;
        else if(!selected.canceled){m.path=selected.path;m.changed=m.path!==(m.space.storage?.path || '');}
      } catch(error) {if(modal===m)throw error;} finally {m.choosing=false;}
      return;
    }
    if(action==='storage-default'){modal.path='';modal.changed=Boolean(modal.space.storage?.path);modal.browse=null;return;}
    if(action==='storage-cancel'){modal.browse=null;return;}
    if(action==='storage-select'){modal.path=modal.browse.path;modal.changed=modal.path!==(modal.space.storage?.path || '');modal.browse=null;return;}
    if(action==='rename'){const s=spaces.find(s=>s.id===data.space);setModal({kind:'rename',title:'重命名空间',id:s.id,name:s.name});return;}
    if(action==='pin'){if(!favorites.some(f=>f.id===data.id&&f.space===data.space))favorites.push({id:data.id,space:data.space,name:data.name});save();return;}
    if(action==='unpin'){favorites=favorites.filter(f=>f.id!==data.id||f.space!==data.space);save();return;}
    if(action==='trash-confirm'||action==='disconnect-confirm'){setModal({kind:'confirm',title:action==='trash-confirm'?'将空间移入回收站？':'断开接入？',text:action==='trash-confirm'?'空间文件可恢复；接入凭证和额外授权将撤销，恢复空间不会恢复接入。':'撤销此身份的凭证和额外授权，保留空间文件。重新接入需要再次确认。',run:async()=>{await manage(action==='trash-confirm'?'space-manage':'connection-manage',{id:data.space || data.id,action:action==='trash-confirm'?'trash':'disconnect'});close();await options.navigate('',false,'personal');}});return;}
    if(action==='confirm'){const m=modal;if(m.saving)return;m.saving=true;try{await m.run();}finally{m.saving=false;}return;}
    if(action==='restore'){await manage('space-manage',{id:data.space,action:'restore'});await options.reload();return;}
    if(action==='connection'){const id=modal.space.id;await manage('connection-manage',{id:data.id,action:data.command});await showSpace(id);return;}
    if(action==='audit'){setModal({kind:'info',title:'最近操作',text:JSON.stringify(await manage('connection-audit',{id:data.id}),null,2)});return;}
    if(action==='revoke'){const id=modal.space.id;await manage('grant-revoke',{id:data.id,grant:data.grant});await showSpace(id);return;}
    if(action==='grant-save'){await manage('grant',{id:data.id,root:modal.item.id});close();return;}
  }
  function bind(settings) {
    options=settings;const root=document.querySelector('#app');
    root.addEventListener('click',async event=>{const b=event.target.closest?.('[data-workspace-action]');if(!b||b.disabled||modal?.saving||modal?.choosing)return;event.preventDefault();try{await handle(b.dataset.workspaceAction,b.dataset);}catch(e){if(modal)modal.error=options.message(e);else options.error(options.message(e));}options.render();});
    root.addEventListener('contextmenu',event=>{const b=event.target.closest?.('.space-tree-node');if(!b||modal)return;const node=b.querySelector('[data-action="space-folder"]');if(!node)return;event.preventDefault();if(node.dataset.id===spaces.find(s=>s.id===node.dataset.space)?.root)void showSpace(node.dataset.space).catch(e=>options.error(options.message(e)));else void handle('pin',node.dataset).then(options.render);});
    root.addEventListener('input',e=>{if(e.target.id==='workspace-name'&&modal)modal.name=e.target.value;});
    root.addEventListener('change',e=>{if(e.target.id==='workspace-reconnect'&&modal)modal.space_id=e.target.value;});
    root.addEventListener('compositionstart',e=>{if(e.target.id==='workspace-name')composing=true;});
    root.addEventListener('compositionend',e=>{if(e.target.id==='workspace-name'){composing=false;if(modal)modal.name=e.target.value;}});
    root.addEventListener('submit',e=>{if(e.target.hasAttribute('data-workspace-form')){e.preventDefault();void submit();}});
    document.addEventListener('keydown',e=>{if(modal&&e.key==='Escape'&&!composing&&!e.isComposing&&!modal.saving&&!modal.choosing){e.preventDefault();close();}});
  }
  window.wanxWorkspaces={bind,reset,storageScope,refresh,observe,sidebar,navigation,storageView,recycled,dialogView,retainEditor,current,spaces:()=>spaces,blocked:()=>Boolean(modal),root:()=>current().root,
    async grant(item){await refresh();setModal({kind:'grant',title:'授予额外读写权限',item});},pin(item){return handle('pin',{space:position.space,id:item.id,name:item.name});},close};
})();
