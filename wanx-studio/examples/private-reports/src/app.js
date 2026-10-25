export async function mount(root, api) {
  const el = (tag, text='') => { const node=document.createElement(tag);node.textContent=text;return node; };
  const context=await api.reports.context();
  root.append(el('h1','工作报告'),el('p',`${context.user.username} · ${context.visibility==='all'?'管理员可查看全部报告':'仅本人报告'}`));
  const status=el('p');status.setAttribute('role','status');
  const layout=el('div');layout.className='layout';const list=el('section'),editor=el('section');layout.append(list,editor);root.append(status,layout);
  let selected=null;
  const title=el('input');title.placeholder='报告标题';title.setAttribute('aria-label','报告标题');
  const content=el('textarea');content.placeholder='写下本次工作报告';content.setAttribute('aria-label','报告内容');
  const save=el('button','保存报告'),fresh=el('button','新建报告'),remove=el('button','删除报告');
  editor.append(title,content,save,fresh,remove);
  const reset=()=>{selected=null;title.value='';content.value='';title.disabled=false;content.disabled=false;save.disabled=false;remove.disabled=true;};
  const run=async fn=>{save.disabled=true;status.textContent='正在处理…';try{await fn();status.textContent='已完成';}catch(error){status.textContent=`操作未完成：${error.message}`;}finally{save.disabled=Boolean(selected&&selected.ownerUserId!==context.user.id);}};
  const refresh=async()=>{
    const result=await api.reports.list({limit:200});list.replaceChildren(el('h2',`${context.visibility==='all'?'全部报告':'我的报告'} · ${result.total}`));
    for(const row of result.items){const button=el('button',`${row.title} · ${row.ownerName}`);button.className='report-row';button.onclick=()=>run(async()=>{
      selected=await api.reports.get({id:row.id});title.value=selected.title;content.value=selected.content;
      title.disabled=true;content.disabled=selected.ownerUserId!==context.user.id;remove.disabled=content.disabled;
    });list.append(button);}
    if(!result.total)list.append(el('p','还没有报告，填写后点击保存。'));
  };
  let pendingCreate=null;
  save.onclick=()=>run(async()=>{
    if(!selected){const fingerprint=JSON.stringify([title.value,content.value]);if(pendingCreate?.fingerprint!==fingerprint)pendingCreate={fingerprint,operationId:crypto.randomUUID()};}
    selected=await api.reports.save(selected?{id:selected.id,content:content.value,expectedHash:selected.contentHash}:{title:title.value,content:content.value,operationId:pendingCreate.operationId});
    pendingCreate=null;title.disabled=true;remove.disabled=false;await refresh();
  });
  fresh.onclick=()=>{reset();pendingCreate=null;status.textContent='';};
  remove.onclick=()=>run(async()=>{if(selected){await api.reports.delete({id:selected.id,expectedHash:selected.contentHash});reset();await refresh();}});
  reset();await refresh();
}
