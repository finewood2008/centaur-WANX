const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function openAssistantKnowledgeAccess({warehouseId, request, isCurrent, message}) {
  const result = await request('data.assistant-access', {warehouseId});
  if (!isCurrent()) return;
  const d = document.createElement('dialog'); d.className = 'data-dialog assistant-access-dialog'; d.dataset.teamDataDialog = '';
  d.setAttribute('aria-label', '助理授权');
  d.innerHTML = '<header><div><h3>助理授权</h3><p>' + esc(result.warehouse.name) + ' · 仅授权知识读取</p></div><button type="button" data-close aria-label="关闭助理授权">×</button></header><form><label>可使用成员<select name="audience"><option value="none">暂不授权成员</option><option value="all">全部成员（含后续加入的成员）</option><option value="selected">指定成员</option></select></label><fieldset><legend>指定成员</legend>' + result.users.filter(m=>m.role!=='admin').map(m=>'<label><input type="checkbox" name="members" value="'+m.id+'"'+(result.members.includes(m.id)?' checked':'')+(m.disabled?' disabled':'')+'/>'+esc(m.name)+(m.disabled?'（已停用）':'')+'</label>').join('') + '</fieldset><p>管理员按现有权限使用。成员只能在助理中选择已授权仓库，不会获得数据仓管理权限。</p><p data-status role="status"></p><footer><button type="button" data-close>取消</button><button type="submit" class="button primary">保存授权</button></footer></form>';
  document.body.append(d); const audience=d.querySelector('select'); audience.value=result.audience;
  const update=()=>{d.querySelector('fieldset').hidden=audience.value!=='selected'}; update(); audience.addEventListener('change',update);
  let busy=false; d.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>{if(!busy)d.close()});
  d.addEventListener('cancel',e=>{if(busy)e.preventDefault()}); d.addEventListener('close',()=>d.remove(),{once:true});
  d.querySelector('form').addEventListener('submit',async event=>{
    event.preventDefault(); if(busy||!isCurrent())return;
    const data=new FormData(event.target),members=data.getAll('members').map(Number),kind=data.get('audience');
    if(kind==='selected'&&!members.length){d.querySelector('[data-status]').textContent='请至少选择一名正常成员。';return}
    busy=true; for(const b of d.querySelectorAll('button,input,select'))b.disabled=true;
    try {await request('data.assistant-access-update',{warehouseId,audience:kind,members,revision:result.revision});if(isCurrent())d.close();else d.remove()}
    catch(e){if(isCurrent())d.querySelector('[data-status]').textContent=message(e)}
    finally {busy=false; for(const b of d.querySelectorAll('button,input,select'))b.disabled=false}
  }); d.showModal();
}

// Add the entry to the current installed Starlink UI without replacing its bundle.
export function wrapAssistantKnowledgeAccess(createOriginal) {
  return options => {
    const view = createOriginal(options); let revision = 0, context = null, admin = false;
    return { ...view,
      sync(state, isAdmin) {
        const next = JSON.stringify([state.account?.accountId, state.account?.clientId, state.activeDeviceId, isAdmin]);
        if (context !== next) { context = next; revision++; }
        admin = isAdmin; return view.sync(state, isAdmin);
      },
      render() {
        const html = view.render();
        if (!admin || html.includes('data-data-action="assistant-access"')) return html;
        return html.replace(/<button\b[^>]*data-data-action="share-create"[^>]*>/, match => {
          const id = match.match(/data-warehouse-id="([a-f0-9-]{36})"/)?.[1];
          return id ? '<button class="button" data-data-action="assistant-access" data-warehouse-id="' + id + '">助理授权</button>' + match : match;
        });
      },
      async action(name, data) {
        if (name !== 'assistant-access') { revision++; return view.action(name, data); }
        if (!admin) return;
        const version = revision;
        return openAssistantKnowledgeAccess({warehouseId:data.warehouseId,request:options.request,
          isCurrent:()=>admin&&revision===version,message:e=>e.code==='ASSISTANT_KNOWLEDGE_CONFLICT'?'授权已变化，请关闭后重新打开。':e.code||e.message});
      },
    };
  };
}
