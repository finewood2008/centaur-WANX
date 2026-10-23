(() => {
  const esc = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
  const personal = () => ({id:'personal',name:'我的空间',root:'',connections:[]});
  const label = {active:'已连接',paused:'已暂停',disconnected:'已断开',pending:'待确认',rejected:'已拒绝'};
  const syncLabels={context:'当前任务上下文',progress:'工作进展',outcome:'工作成果',project_memory:'项目记忆',user_memory:'用户相关记忆'};
  const syncDefault=()=>({context:true,progress:true,outcome:true,project_memory:false,user_memory:false,project_scope:''});
  const syncOptions=m=>`<fieldset class="space-sync-options"><legend>同步到此空间</legend>${Object.entries(syncLabels).map(([k,v])=>`<label class="space-sync-choice"><input type="checkbox" data-sync-option="${k}" ${m.policy[k]?'checked':''}><span>${v}<small>${{context:'任务目标、背景、用户要求与约束',progress:'关键决定、完成情况、待办与阻塞',outcome:'结果摘要、文件引用与验证情况',project_memory:'仅提交指定项目中可提供的记忆',user_memory:'仅提交用户允许同步的偏好与协作习惯'}[k]}</small></span></label>`).join('')}<label>项目范围<input data-sync-project value="${esc(m.policy.project_scope || '')}" maxlength="240" placeholder="开启项目记忆时填写项目名称或范围"></label></fieldset><p class="muted">按所选范围自动提交可提供的内容；宿主未提供的记忆会明确标记，不表示已经备份。关闭选项只停止后续提交，已有记录保留。</p>`;
  const syncState=(data,k,task=data.tasks?.[0])=>{
    if(!data.policy.options[k])return '未开启';
    if(data.connection_state==='paused')return '已暂停';
    if(data.connection_state==='disconnected')return '已断开';
    const item=task?.categories?.[k];
    if(!item)return k==='outcome'&&task?.state==='active'?'等待任务结束':'等待提交';
    return {provided:'已同步',empty:'无相关内容',unsupported:'宿主不支持',denied:'无权限提供'}[item.status] || '等待提交';
  };
  const bytes = n => n > 1048576 ? `${(n/1048576).toFixed(1)} MB` : `${((n || 0)/1024).toFixed(1)} KB`;
  let options, spaces=[personal()], requests=[], favorites=[], cache=new Map(), expanded=new Set(), automatic=new Set(), collapsed=new Set(), menu=null, key='', epoch=0, modal=null, composing=false;
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
    epoch++; key=`wanx-space-favorites:${(window.location?.origin || "local")}:${scope || ''}`; spaces=[personal()];requests=[];cache.clear();expanded.clear();automatic.clear();collapsed.clear();menu=null;modal=null;composing=false;
    position={space:'personal',parent:'',trash:false};history=[];index=-1;
    try { favorites=JSON.parse(localStorage.getItem(key) || '[]').filter(f=>typeof f.space==='string'&&typeof f.id==='string').slice(0,100); } catch {favorites=[];}
  }
  async function refresh() {
    const before=epoch;
    try { const result=await manage('spaces'); if(Array.isArray(result)) spaces=result; requests=await manage('requests'); }
    catch(error) { if(before!==epoch)throw error; if(!String(error.message).includes('UPGRADE')&&!String(error.message).includes('404'))throw error; }
    cache.clear();
    await Promise.all([...new Set([...expanded,...automatic])].map(async k=>{const [space,id]=k.split(':');if(!spaces.some(s=>s.id===space&&!s.trashed)){expanded.delete(k);return;}try{await children(space,id);}catch(error){if(before!==epoch)throw error;expanded.delete(k);}}));
    const resolved=await Promise.all(favorites.map(async f=>{
      const space=spaces.find(s=>s.id===f.space);
      if(space && f.id===space.root)return {...f,name:space.name,unavailable:Boolean(space.trashed)};
      try { const item=await call('stat',{id:f.id});return {...f,space:item.space_id || 'personal',name:item.name,unavailable:false}; }
      catch(error) { if(before!==epoch)throw error;return {...f,name:f.name || '位置暂不可用',unavailable:true}; }
    }));
    if(before!==epoch)return;
    favorites=resolved; save();
    filterHistory(h=>spaces.some(s=>s.id===h.space&&!s.trashed));
  }
  async function children(space,id) {
    const k=nodeKey(space,id);
    if(!cache.has(k)) { const data=await call('list',{parent:id,space_id:space});cache.set(k,data.items.filter(i=>i.kind==='folder')); }
    return cache.get(k);
  }
  async function observe(next,listing,record=true) {
    if(position.space!==next.space||position.parent!==next.parent||position.trash!==next.trash)collapsed.clear();
    position={...next}; automatic.clear();
    const space=current(),ancestors=listing.breadcrumbs.map(c=>c.id);
    if(!next.trash) {
      cache.set(nodeKey(next.space,next.parent),listing.items.filter(i=>i.kind==='folder'));
      if(next.parent!==space.root)for(const id of [space.root,...ancestors.filter(id=>id!==next.parent)])automatic.add(nodeKey(next.space,id));
      await Promise.all([...automatic].map(k=>{const [scope,id]=k.split(':');return children(scope,id);}));
    }
    const entry={...position,ancestors};
    const previous=history[index];
    if(record&&(!previous||['space','parent','trash'].some(k=>previous[k]!==position[k]))) {history=history.slice(0,index+1);history.push(entry);index=history.length-1;}
    else if(index>=0)history[index]=entry;
  }
  const icon = name => options.icon?.(name) || '';
  const pinned = (space,id) => favorites.some(f=>f.space===space&&f.id===id);
  function tree(space,id,name,depth=0) {
    const k=nodeKey(space,id),open=expanded.has(k)||(automatic.has(k)&&!collapsed.has(k)),selected=!position.trash&&position.space===space&&position.parent===id;
    const data=`data-id="${esc(id)}" data-space="${esc(space)}" data-name="${esc(name)}"`,kind=depth?'folder':'space';
    return `<div class="space-tree-node" style="--depth:${depth}" data-sidebar-kind="${kind}" ${data}><button class="space-tree-toggle ${open?'is-expanded':''}" data-workspace-action="expand" ${data} aria-label="${open?'折叠':'展开'}${esc(name)}" aria-expanded="${open}">${icon('chevron')}</button><button class="space-nav ${selected?'active':''}" data-action="space-folder" ${data} title="${esc(name)}" ${selected?'aria-current="page"':''}>${icon(depth?'folder':'drive')}<span>${esc(name)}</span></button><button class="space-tree-more" data-workspace-action="menu" data-sidebar-kind="${kind}" ${data} aria-label="${esc(name)}的侧栏操作" title="更多操作" aria-haspopup="menu">${icon('more')}</button></div>${open&&depth<40?(cache.get(k)||[]).map(c=>tree(space,c.id,c.name,depth+1)).join(''):''}`;
  }
  function sidebar() {
    const own=spaces.find(s=>s.id==='personal') || personal(),pending=requests.filter(r=>r.status==='pending').length;
    return `<nav class="space-tree" aria-label="空间位置"><section class="space-nav-section" aria-label="常用位置"><h3 class="space-sidebar-caption">常用位置</h3>${favorites.map(f=>{const data=`data-id="${esc(f.id)}" data-space="${esc(f.space)}" data-name="${esc(f.name)}"`;return `<div class="space-favorite" data-sidebar-kind="favorite" ${data}><button class="space-nav ${!position.trash&&position.space===f.space&&position.parent===f.id?'active':''}" data-action="space-folder" ${data} title="${esc(f.name)}${f.unavailable?' · 位置暂不可用':''}" ${f.unavailable?'disabled':''}>${icon('star')}<span>${esc(f.name || '位置暂不可用')}</span></button><button class="space-tree-more" data-workspace-action="menu" data-sidebar-kind="favorite" ${data} aria-label="${esc(f.name)}的快捷入口操作" title="更多操作" aria-haspopup="menu">${icon('more')}</button></div>`;}).join('') || '<p class="space-sidebar-note">尚未固定位置</p>'}</section><section class="space-nav-section" aria-label="我的空间">${tree(own.id,own.root,'我的空间')}</section><section class="space-nav-section" aria-label="来源"><div class="space-sidebar-caption space-source-heading"><h3>来源</h3><button class="space-source-add" data-workspace-action="requests" aria-label="Agent 接入${pending?`，${pending} 个待确认`:''}" title="接入 Agent 或处理申请">${icon('plus')}${pending?`<span class="space-request-count">${pending}</span>`:''}</button></div>${spaces.filter(s=>s.id!=='personal'&&!s.trashed).map(s=>tree(s.id,s.root,s.name)).join('')}</section></nav>`;
  }
  function footerNavigation() {return `<button class="space-nav space-recycle-entry ${position.trash?'active':''}" data-action="space-recycle" ${position.trash?'aria-current="page"':''}>${icon('trash')}<span>回收站</span></button>`;}
  function dismissMenu() {menu=null;document.querySelector('.space-sidebar-menu')?.remove?.();}
  function showMenu(data,x,y) {
    if(modal)return;
    options.dismissFileMenu?.();
    menu={kind:data.sidebarKind,space:data.space,id:data.id,name:data.name,x:Math.max(8,Math.min(Number(x)||8,(window.innerWidth||1024)-218)),y:Math.max(8,Math.min(Number(y)||8,(window.innerHeight||768)-260))};
    options.render();
  }
  function menuView() {
    if(!menu||modal)return '';
    const t=menu,choice=(text,command,danger=false)=>`<button role="menuitem" data-workspace-action="menu-command" data-command="${command}" ${danger?'class="danger-text"':''}>${esc(text)}</button>`;
    let items=choice(t.kind==='folder'?'打开文件夹':'打开','open');
    if(t.kind==='favorite')items+=choice('在空间中显示','locate')+'<hr role="separator">'+choice('取消固定','unpin');
    else {
      items+=choice(pinned(t.space,t.id)?'取消固定':'固定到常用位置',pinned(t.space,t.id)?'unpin':'pin');
      if(t.kind==='folder')items+='<hr role="separator">'+choice('重命名…','rename')+choice('移动到…','move')+'<hr role="separator">'+choice('移入回收站…','trash',true);
      else {if(t.space!=='personal')items+=choice('重命名…','rename');items+=choice('空间管理…','manage');if(t.space!=='personal')items+='<hr role="separator">'+choice('移入回收站…','trash',true);}
    }
    return `<div class="space-context-menu space-sidebar-menu" role="menu" aria-label="${esc(t.name)}的侧栏操作" style="left:${t.x}px;top:${t.y}px">${items}</div>`;
  }
  async function resolveTarget(target) {
    if(target.kind==='space'||spaces.some(s=>s.id===target.space&&s.root===target.id)) {
      const live=await manage('spaces'),space=live.find(s=>s.id===target.space&&!s.trashed);
      if(!space)throw Error('SPACE_NOT_FOUND');
      return {...target,space:space.id,id:space.root,name:space.name};
    }
    const item=await call('stat',{id:target.id});
    if(item.kind!=='folder'||(target.kind!=='favorite'&&item.space_id!==target.space))throw Error('SPACE_CONTEXT_CHANGED');
    return {...target,space:item.space_id || 'personal',name:item.name,item};
  }
  async function menuCommand(command) {
    const target=menu;if(!target)return;dismissMenu();
    if(command==='unpin'){await handle('unpin',{space:target.space,id:target.id});return;}
    const resolved=await resolveTarget(target);
    if(command==='open'||command==='locate'){await options.navigate(resolved.id,false,resolved.space);return;}
    if(command==='pin'){await handle('pin',{space:resolved.space,id:resolved.id,name:resolved.name});return;}
    if(target.kind==='folder'){await options.fileAction(command,resolved.item);return;}
    if(command==='manage'){await showSpace(resolved.space);return;}
    await handle(command==='trash'?'trash-confirm':command,{space:resolved.space});
  }
  function filterHistory(keep) {const current=history[index];history=history.filter(keep);const next=history.indexOf(current);index=next<0?Math.min(index,history.length-1):next;}
  function invalidated(items) {
    filterHistory(h=>!items.some(item=>h.space===(item.space_id || item.space)&&(item.root===true||h.parent===item.id||h.ancestors?.includes(item.id))));
  }
  async function reconcile(next,ancestors=[]) {
    const live=spaces.find(s=>s.id===next.space&&!s.trashed);
    if(!live)return {space:'personal',parent:'',trash:next.trash};
    if(next.trash||next.parent===live.root)return next;
    for(const id of [...new Set([next.parent,...ancestors.map(c=>c.id).reverse(),live.root])]) {
      if(id===live.root)return {...next,parent:id};
      try {const item=await call('stat',{id});if(item.kind==='folder'&&item.space_id===next.space)return {...next,parent:id};}
      catch(error){if(!String(error.message).includes('SPACE_NOT_FOUND'))throw error;}
      invalidated([{space:next.space,id}]);
    }
    return {...next,parent:live.root};
  }
  function navigation() {return `<button class="space-icon-button" data-workspace-action="back" aria-label="后退" ${index<=0?'disabled':''}>←</button><button class="space-icon-button" data-workspace-action="forward" aria-label="前进" ${index>=history.length-1?'disabled':''}>→</button>`;}
  function storageView() {
    if(position.trash)return '';
    const space=current(),location=space.storage;
    return `<div class="space-storage-location"><div><small>存储位置</small><button class="text-button" data-workspace-action="storage" data-space="${esc(space.id)}" aria-label="设置当前空间存储目录">设置</button></div><span title="${esc(location?.directory || '')}">${esc(location?.path || '默认位置')}</span>${location?.available===false?'<small class="danger-text">目录暂不可用</small>':''}</div>`;
  }
  function recycled() { return spaces.filter(s=>s.trashed).map(s=>`<div class="space-recycled"><strong>${esc(s.name)}</strong><span>空间 · ${bytes(s.bytes+s.pending_bytes)}</span>${button('恢复空间','restore',`data-space="${s.id}"`)}</div>`).join(''); }
  function setModal(value) { dismissMenu();modal=value; composing=false;options.render();const input=document.querySelector('#workspace-name');input?.focus();input?.select(); }
  function close() {modal=null;dismissMenu();composing=false;options.render();}
  async function showSpace(id) {
    await refresh();const space=spaces.find(s=>s.id===id);if(!space)return;
    const connections=await Promise.all(space.connections.map(async c=>({...c,grants:await manage('grants',{id:c.id})})));
    setModal({kind:'manage',title:space.name,space,connections});
  }
  function dialogView() {
    if(!modal)return '';
    let body='';const m=modal;
    if(m.kind==='requests') body=`<p>每份配置对应一个独立身份。复制同一配置会共享接入和空间。软件名称仅供参考。</p>${button('生成新的 MCP 配置','config')}<div class="space-links-list">${requests.map(r=>`<article class="space-link-card"><strong>${esc(r.name)}</strong><small>${label[r.status]} · 身份 ${esc(r.profile.slice(0,10))}</small>${r.status!=='rejected'?button(r.status==='pending'?'确认接入…':'重新接入…','approve-form',`data-id="${r.id}"`):''}${r.status==='pending'?button('拒绝','reject',`data-id="${r.id}"`):''}</article>`).join('')||'<p class="muted">尚无接入申请。先将配置加入 Agent，再连接 MCP。</p>'}</div>`;
    if(['approve','rename'].includes(m.kind)) body=`<form data-workspace-form><label for="workspace-name">${m.kind==='approve'?'来源名称':'空间名称'}</label><input id="workspace-name" data-editor-key="${m.kind}:${m.id}" name="name" value="${esc(m.name)}" required maxlength="80" autocomplete="off">${m.kind==='approve'?`<label for="workspace-reconnect">保存位置</label><select id="workspace-reconnect"><option value="">创建独立空间</option>${spaces.filter(s=>s.id!=='personal'&&!s.trashed&&s.connections.every(c=>c.state==='disconnected')).map(s=>`<option value="${s.id}" ${m.space_id===s.id?'selected':''}>关联原空间：${esc(s.name)}</option>`).join('')}</select><p class="muted">确认后，此身份可读写自己的空间。其他空间需要单独授权。</p>${syncOptions(m)}`:''}<button class="button primary" type="submit">${m.kind==='approve'?'确认接入':'保存'}</button></form>`;
    if(m.kind==='storage') body=`<p>为“${esc(m.space.name)}”设置文件保存位置。</p><p class="muted space-storage-current" title="${esc(m.space.storage?.directory || '')}">当前位置：${esc(m.space.storage?.path || '默认位置')}</p><form data-workspace-form><div class="space-directory-selection"><span aria-hidden="true">▱</span><div><small>保存到 · 万象主机</small><strong data-storage-path title="${esc(m.path)}">${esc(m.path || '默认位置')}</strong></div>${button(m.choosing?'正在打开…':'选择文件夹…','storage-choose')}</div><div class="market-actions">${button('使用默认位置','storage-default')}</div>${m.browse?`<div class="space-directory-browser" aria-label="万象主机文件夹"><div class="space-directory-heading">${button('返回上级','storage-browse',`data-path="${esc(m.browse.parent)}" ${m.browse.path===m.browse.root?'disabled':''}`)}<span title="${esc(m.browse.path)}">${esc(m.browse.path)}</span></div><div class="space-directory-folders">${m.browse.entries.map(d=>button('▱ '+d.name,'storage-browse',`data-path="${esc(d.path)}"`)).join('')||'<p class="muted">没有子文件夹</p>'}</div><div class="market-actions">${button('选择此文件夹','storage-select')}${button('取消选择','storage-cancel')}</div></div>`:''}<p class="muted">万象会在所选位置建立专用子目录，迁移现有文件、保留版本和回收站内容。选择后点击“迁移并保存”才会更改位置。</p><button class="button primary" type="submit" ${!m.changed||m.browse||m.choosing?'disabled':''}>迁移并保存</button></form><p class="muted" data-storage-progress ${m.saving?'':'hidden'}>正在迁移并校验文件，请稍候…</p>`;
    if(m.kind==='info') body=`<pre class="space-text-preview">${esc(m.text)}</pre>${button('复制','copy-info')}`;
    if(m.kind==='manage') body=`<p>用量 ${bytes(m.space.bytes+m.space.pending_bytes)}<small class="muted"> · 包含上一版本、回收站及未完成上传</small></p><div class="market-actions">${m.space.id!=='personal'?button('重命名','rename',`data-space="${m.space.id}"`):''}${button('固定到常用位置','pin',`data-space="${m.space.id}" data-id="${m.space.root}" data-name="${esc(m.space.name)}"`)}${m.space.id!=='personal'?button('移入回收站…','trash-confirm',`data-space="${m.space.id}"`):''}</div>${m.connections.map(c=>`<article class="space-link-card"><strong>${esc(c.name)} · ${label[c.state]}</strong><small>接入身份 ${esc(c.id)}<br>最近使用：${c.last_used?new Date(c.last_used*1000).toLocaleString():'尚未使用'}</small><div class="market-actions">${c.state!=='disconnected'?button(c.state==='paused'?'恢复接入':'暂停接入','connection',`data-id="${c.id}" data-command="${c.state==='paused'?'resume':'pause'}"`)+button('断开接入…','disconnect-confirm',`data-id="${c.id}"`):''}${button('最近操作','audit',`data-id="${c.id}"`)}${button('上下文与记忆','sync-open',`data-id="${c.id}"`)}</div><h4>额外读写授权</h4><p class="muted">在文件或文件夹的右键菜单中添加授权。</p>${c.grants.filter(g=>!g.revoked).map(g=>`<div class="space-grant"><span>${esc(g.name || '资源已删除')} · ${g.kind==='folder'?'含子目录':'文件'}</span>${button('撤销','revoke',`data-id="${c.id}" data-grant="${g.id}"`)}</div>`).join('')||'<small>没有额外授权</small>'}</article>`).join('')||'<p class="muted">我的空间由你管理。Agent 仅能访问明确授予的资源。</p>'}`;
    if(m.kind==='sync-settings')body=`<form data-workspace-form data-sync-editor="${esc(m.id)}">${syncOptions(m)}<button class="button primary" type="submit">保存同步设置</button></form>`;
    if(m.kind==='sync-status') {
      const data=m.sync,task=data.tasks?.[0],enabled=Object.keys(syncLabels).filter(k=>data.policy.options[k]),partial=enabled.some(k=>['宿主不支持','无权限提供','无相关内容'].includes(syncState(data,k)) || (task?.state==='finished'&&syncState(data,k)==='等待提交'));
      const state=m.error?'同步状态获取失败':data.connection_state!=='active'?(label[data.connection_state] || '不可用'):!enabled.length?'未开启同步':data.delivery?.state==='saving'?'等待保存':data.delivery?.state==='failed'?'同步失败':!task?'等待任务':partial?'部分同步':task.state==='finished'?'最近提交已保存':'进行中 · 最近提交已保存';
      body=`<div class="space-sync-heading"><strong>${esc(state)}</strong><small>记录占用 ${bytes(data.bytes)} · 规则版本 ${data.policy.revision}</small></div><p class="muted">${task?`最近确认保存于 ${esc(new Date(task.modified*1000).toISOString())}`:'已连接后，Agent 开始任务时提交上下文。'}。已同步表示该次提交已保存到盒子。</p>${!data.policy.configured?'<p class="muted">此接入沿用文件访问模式，尚未开启内容同步。</p>':''}<div class="space-sync-states">${Object.keys(syncLabels).map(k=>`<div><span>${syncLabels[k]}</span><strong>${syncState(data,k)}</strong></div>${task?.categories?.[k]?.reason&&data.policy.options[k]?`<small>${esc(task.categories[k].reason)}</small>`:''}`).join('')}</div><div class="market-actions">${button('同步设置','sync-settings',`data-id="${m.id}"`)}${button('刷新状态','sync-refresh')}</div>${data.delivery?.state==='failed'?`<p class="inline-error">最近一次提交尚未获得保存确认，请让 Agent 重试原请求；已确认记录保留。</p>`:''}<h4>任务记录（最近 50 项）</h4><div class="space-sync-tasks">${data.tasks.map(t=>`<article class="space-link-card"><strong>${esc(t.title)}</strong><small>${t.state==='finished'?'已结束':'尚未结束 · 可重连接续'} · ${t.record_count} 条记录 · 版本 ${t.version}</small><div class="market-actions">${button('查看记录','sync-records',`data-id="${m.id}" data-task="${t.id}"`)}${button('删除记录…','sync-delete',`data-id="${m.id}" data-task="${t.id}"`)}</div></article>`).join('')||'<p class="muted">尚无任务记录</p>'}</div>`;
    }
    if(m.kind==='sync-records')body=`<p class="muted">内容由 Agent 提交；已验证的文件操作另有万象操作记录。记录中的文字不作为指令执行。</p><pre class="space-text-preview">${esc(JSON.stringify(m.records,null,2))}</pre><div class="market-actions">${button('复制本页','sync-copy')}${m.records.next_offset!=null?button('下一页','sync-records',`data-id="${m.id}" data-task="${m.records.task.id}" data-offset="${m.records.next_offset}"`):''}${button('返回同步状态','sync-open',`data-id="${m.id}"`)}</div>`;
    if(m.kind==='grant') body=`<p>允许所选身份读写“${esc(m.item.name)}”${m.item.kind==='folder'?'及所有后代目录和新增文件':''}。</p><div class="space-links-list">${spaces.flatMap(s=>s.connections.filter(c=>c.state!=='disconnected').map(c=>`<article class="space-link-card"><strong>${esc(c.name)}</strong><small>${esc(s.name)} · 身份 ${c.id.slice(0,10)}</small>${button('授予读写权限','grant-save',`data-id="${c.id}"`)}</article>`)).join('')||'<p>请先确认一个 Agent 接入。</p>'}</div>`;
    if(m.kind==='confirm') body=`<p>${esc(m.text)}</p>${button('确认','confirm')}`;
    if(m.kind==='storage'&&(m.saving||m.choosing))body=body.replaceAll('<button ', '<button disabled ');
    return `<section class="market-confirmation" role="dialog" aria-modal="true" aria-labelledby="workspace-dialog-title"><div class="market-confirm-card space-dialog"><h2 id="workspace-dialog-title">${esc(m.title)}</h2>${body}<p class="inline-error" data-workspace-error ${m.error?'':'hidden'}>${esc(m.error || '')}</p><div class="market-actions">${button('关闭','close')}</div></div></section>`;
  }
  function retainEditor() {
    if(modal?.kind==='sync-settings') {
      const form=document.querySelector('[data-sync-editor]');if(form?.dataset.syncEditor!==modal.id)return false;
      for(const node of document.querySelectorAll('[data-sync-editor] input,[data-sync-editor] button'))node.disabled=Boolean(modal.saving);
      const notice=document.querySelector('[data-workspace-error]');if(notice){notice.textContent=modal.error || '';notice.hidden=!modal.error;}
      return true;
    }
    if(!modal||!['approve','rename'].includes(modal.kind))return false;
    const input=document.querySelector('#workspace-name');if(input?.dataset.editorKey!==`${modal.kind}:${modal.id}`)return false;
    const notice=document.querySelector('[data-workspace-error]');if(notice){notice.textContent=modal.error || '';notice.hidden=!modal.error;}
    const progress=document.querySelector('[data-storage-progress]');if(progress)progress.hidden=!modal.saving;
    input.disabled=Boolean(modal.saving);
    for(const field of document.querySelectorAll('.space-dialog input,.space-dialog select'))field.disabled=Boolean(modal.saving);
    for(const b of document.querySelectorAll('.space-dialog button'))b.disabled=Boolean(modal.saving);
    return true;
  }
  async function submit() {
    const m=modal;if(!m||m.saving||m.choosing||composing||(m.kind==='storage'&&(!m.changed||m.browse)))return;
    m.saving=true;options.render();
    try {
      if(m.kind==='sync-settings') {
        await manage('sync-policy',{id:m.id,options:m.policy,expected:m.expected});
        if(modal===m)await showSync(m.id);return;
      }
      const result=await manage(m.kind==='storage'?'storage-set':m.kind==='approve'?'approve':'space-manage',m.kind==='storage'?{id:m.id,path:m.path}:m.kind==='approve'?{id:m.id,name:m.name,space_id:m.space_id,sync_policy:m.policy}:{id:m.id,action:'rename',name:m.name});if(modal!==m)return;close();await options.reload();if(result?.cleanup_pending)options.error('迁移已完成，部分旧副本暂未清理。新位置中的文件可正常使用。'); }
    catch(error){if(modal===m)m.error=options.message(error);}finally{m.saving=false;options.render();}
  }
  async function handle(action,data) {
    if(action==='close'){close();return;}
    if(action==='expand'){const k=nodeKey(data.space,data.id);if(expanded.has(k)||(automatic.has(k)&&!collapsed.has(k))){expanded.delete(k);collapsed.add(k);}else{await children(data.space,data.id);expanded.add(k);collapsed.delete(k);}return;}
    if(action==='menu-command'){await menuCommand(data.command);return;}
    if(action==='back'||action==='forward'){index+=action==='back'?-1:1;index=Math.max(0,Math.min(history.length-1,index));const p=history[index];if(p)await options.navigate(p.parent,p.trash,p.space,false);return;}
    if(action==='requests'){await refresh();setModal({kind:'requests',title:'Agent 接入'});return;}
    if(action==='config'){setModal({kind:'info',title:'通用 MCP 接入配置',text:JSON.stringify(await manage('agent-config'),null,2)});return;}
    if(action==='copy-info'){await navigator.clipboard.writeText(modal.text);return;}
    if(action==='approve-form'){const r=requests.find(r=>r.id===data.id);if(r)setModal({kind:'approve',id:r.id,title:'确认来源与空间',name:r.name,space_id:r.status==='disconnected'?r.space_id:'',policy:syncDefault()});return;}
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
    if(action==='trash-confirm'||action==='disconnect-confirm'){
      if(action==='trash-confirm'&&data.space==='personal')throw Error('SPACE_MANAGED_ROOT');
      const target=action==='trash-confirm'?await resolveTarget({kind:'space',space:data.space}):null;
      setModal({kind:'confirm',title:action==='trash-confirm'?`将“${target.name}”移入回收站？`:'断开接入？',text:action==='trash-confirm'?'空间文件可恢复；接入凭证和额外授权将撤销，恢复空间不会恢复接入。':'撤销此身份的凭证和额外授权，保留空间文件。重新接入需要再次确认。',run:async()=>{if(target)await resolveTarget(target);await manage(action==='trash-confirm'?'space-manage':'connection-manage',{id:data.space || data.id,action:action==='trash-confirm'?'trash':'disconnect'});close();if(target){invalidated([{space:target.space,id:target.id,root:true}]);if(position.space===target.space){await options.navigate('',false,'personal');return;}}await options.reload();}});return;}
    if(action==='confirm'){const m=modal;if(m.saving)return;m.saving=true;try{await m.run();}finally{m.saving=false;}return;}
    if(action==='restore'){await manage('space-manage',{id:data.space,action:'restore'});await options.reload();return;}
    if(action==='connection'){const id=modal.space.id;await manage('connection-manage',{id:data.id,action:data.command});await showSpace(id);return;}
    if(action==='sync-open'){await showSync(data.id);return;}
    if(action==='sync-refresh'){await updateSync();return;}
    if(action==='sync-settings'){const result=await manage('sync-status',{id:data.id});setModal({kind:'sync-settings',id:data.id,title:'同步设置',expected:result.policy.revision,policy:{...result.policy.options}});return;}
    if(action==='sync-records'){const records=await manage('task-records',{id:data.id,task_id:data.task,offset:Number(data.offset || 0)});setModal({kind:'sync-records',id:data.id,title:records.task.title,records});return;}
    if(action==='sync-copy'){await navigator.clipboard.writeText(JSON.stringify(modal.records,null,2));return;}
    if(action==='sync-delete'){const old=modal,task=old.sync.tasks.find(t=>t.id===data.task);if(!task)return;setModal({kind:'confirm',title:`删除“${task.title}”的记录？`,text:'删除此任务的上下文、进展、成果摘要及历史记录。已产出的文件和操作审计保留，Agent 后续需要新建任务。',run:async()=>{await manage('task-delete',{id:data.id,task_id:data.task});await showSync(data.id);}});return;}
    if(action==='audit'){setModal({kind:'info',title:'最近操作',text:JSON.stringify(await manage('connection-audit',{id:data.id}),null,2)});return;}
    if(action==='revoke'){const id=modal.space.id;await manage('grant-revoke',{id:data.id,grant:data.grant});await showSpace(id);return;}
    if(action==='grant-save'){await manage('grant',{id:data.id,root:modal.item.id});close();return;}
  }
  async function showSync(id) {const sync=await manage('sync-status',{id});setModal({kind:'sync-status',id,title:'上下文与记忆',sync});}
  let syncing=false;
  async function updateSync() {
    const m=modal;if(m?.kind!=='sync-status'||syncing)return;syncing=true;
    try{const sync=await manage('sync-status',{id:m.id});if(modal===m){m.sync=sync;m.error='';options.render();}}
    catch(error){if(modal===m){m.error=options.message(error);options.render();}}
    finally{syncing=false;}
  }
  function bind(settings) {
    options=settings;const root=document.querySelector('#app');
    root.addEventListener('click',async event=>{
      const b=event.target.closest?.('[data-workspace-action]');if(!b||b.disabled||modal?.saving||modal?.choosing)return;
      const before=epoch;event.preventDefault();try{
        if(b.dataset.workspaceAction==='menu'){const r=b.getBoundingClientRect?.();showMenu(b.dataset,r?.right || event.clientX,r?.bottom || event.clientY);return;}
        await handle(b.dataset.workspaceAction,b.dataset);
      }catch(e){if(before!==epoch)return;if(modal)modal.error=options.message(e);else options.error(options.message(e));}options.render();
    });
    root.addEventListener('contextmenu',event=>{const node=event.target.closest?.('[data-sidebar-kind]');if(!node||modal)return;event.preventDefault();showMenu(node.dataset,event.clientX,event.clientY);});
    document.addEventListener('pointerdown',event=>{if(menu&&!event.target.closest?.('.space-sidebar-menu')&&!event.target.closest?.('[data-workspace-action="menu"]'))dismissMenu();});
    document.addEventListener('keydown',event=>{
      if(!menu)return;
      if(event.key==='Escape'){event.preventDefault();const target=menu;dismissMenu();options.render();document.querySelector(`[data-workspace-action="menu"][data-sidebar-kind="${target.kind}"][data-space="${target.space}"][data-id="${target.id}"]`)?.focus?.();return;}
      if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();const buttons=Array.from(document.querySelectorAll('.space-sidebar-menu [role="menuitem"]'));const index=buttons.indexOf(document.activeElement);buttons[(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}
    });
    root.addEventListener('input',e=>{if(e.target.id==='workspace-name'&&modal)modal.name=e.target.value;if(e.target.hasAttribute?.('data-sync-project')&&modal?.policy)modal.policy.project_scope=e.target.value;});
    root.addEventListener('change',e=>{if(e.target.id==='workspace-reconnect'&&modal)modal.space_id=e.target.value;const k=e.target.dataset?.syncOption;if(k&&modal?.policy)modal.policy[k]=e.target.checked;});
    root.addEventListener('compositionstart',e=>{if(e.target.id==='workspace-name'||e.target.hasAttribute?.('data-sync-project'))composing=true;});
    root.addEventListener('compositionend',e=>{if(e.target.id==='workspace-name'||e.target.hasAttribute?.('data-sync-project')){composing=false;if(modal&&e.target.id==='workspace-name')modal.name=e.target.value;if(modal?.policy&&e.target.hasAttribute?.('data-sync-project'))modal.policy.project_scope=e.target.value;}});
    root.addEventListener('submit',e=>{if(e.target.hasAttribute('data-workspace-form')){e.preventDefault();void submit();}});
    document.addEventListener('keydown',e=>{if(modal&&e.key==='Escape'&&!composing&&!e.isComposing&&!modal.saving&&!modal.choosing){e.preventDefault();close();}});
  }
  window.wanxWorkspaces={bind,reset,storageScope,refresh,observe,sidebar,navigation,footerNavigation,menuView,dismissMenu,invalidated,reconcile,storageView,recycled,dialogView,retainEditor,current,spaces:()=>spaces,modalOpen:()=>Boolean(modal),blocked:()=>Boolean(modal||menu),root:()=>current().root,updateSync,
    async grant(item){await refresh();setModal({kind:'grant',title:'授予额外读写权限',item});},pin(item){return handle('pin',{space:position.space,id:item.id,name:item.name});},close};
})();
