const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const scopeNames={documents:'材料信息',evidence:'证据',graph:'图谱',search:'检索',reasoning:'推理与资料'};
const endpoints=[['工具','xingtu_warehouse','仓库概况'],['工具','xingtu_documents','材料信息'],['工具','xingtu_graph','知识图谱与来源'],['工具','xingtu_search','证据检索'],['工具','xingtu_evidence','证据片段']];
const date=v=>v?new Date(Number(v)*1000).toLocaleDateString('zh-CN'):'—';
export async function openDataShare({warehouse,request,isCurrent,message,startCreate=false,onChanged=()=>{}}){
 const call=(name,input={})=>request('data.'+name,{...input,warehouseId:warehouse.id});
 const details=await call('share-details');if(!isCurrent())return;
 const d=document.createElement('dialog');d.dataset.teamDataDialog='';d.className='data-dialog data-share-dialog';
 let handle=null,newKey=null,disposed=false;
 const status=()=>d.querySelector('[data-share-status]');
 const current=()=>!disposed&&isCurrent()&&d.isConnected;
 const clearSecret=()=>{const input=d.querySelector('[data-share-secret]');if(input)input.value='';};
 const keyList=items=>items.length?items.map(k=>{const active=!k.revoked_at&&Number(k.expires_at)*1000>Date.now();return `<article class="data-share-key-row"><div><strong>${esc(k.name)}</strong><code>${esc(k.prefix)}••••••</code><small>${esc((k.scopes||[]).map(s=>scopeNames[s]||s).join(' · '))}</small></div><div><span class="data-status ${active?'ready':''}">${k.revoked_at?'已撤销':active?'有效':'已到期'}</span><small>${date(k.expires_at)} 到期</small></div></article>`}).join(''):'<p class="data-share-no-key">尚无访问 Key，可在下方为当前仓生成只读凭证。</p>';
 d.innerHTML=`<div class="data-dialog-heading"><div><h3>仓库访问 Key</h3><p>${esc(details.warehouse?.name||warehouse.name)} · Key 仅绑定此仓库</p></div><button type="button" data-share-action="close" aria-label="关闭分享接口">×</button></div><div class="data-share-columns is-warehouse-key"><section class="data-share-access"><div class="data-share-code-heading"><h4>「${esc(warehouse.name)}」的访问 Key</h4><span>只读授权</span></div><div class="data-share-keys">${keyList(details.keys||[])}</div><div class="data-share-new-key" hidden><strong>新建 Key · 请立即复制保存</strong><p>完整 Key 仅在本次窗口内可查看或复制，关闭后不再提供。</p><div class="data-share-secret-row"><input data-share-secret type="password" readonly aria-label="新建访问 Key" autocomplete="off"><button type="button" class="button" data-share-action="reveal">显示</button><button type="button" class="button primary" data-share-action="copy-key">复制 Key</button></div></div><details class="data-share-create"><summary>＋ 新建只读 Key</summary><form data-share-create-form><label>用途名称<input name="name" required maxlength="60" placeholder="如：客户服务 Agent" autocomplete="off"></label><label>有效期<select name="days"><option value="7">7 天</option><option value="30" selected>30 天</option><option value="90">90 天</option><option value="365">365 天</option></select></label><p>授权材料信息、图谱、证据与检索；不包含写入和推理调用。</p><button class="button primary" type="submit">生成只读 Key</button></form></details><p class="data-share-caption">已有 Key 只显示前缀。授权撤销与应用绑定，可在星图「接口授权」中管理。</p><button class="text-button" data-share-action="manage">在星图中管理授权 ↗</button></section><section class="data-share-api"><h4>星图独立 MCP</h4><div class="data-share-base"><span>Streamable HTTP · 星图知识读取</span><div><code>${esc(details.mcpUrl||"MCP 暂不可用")}</code><button class="button" data-share-action="copy" data-kind="mcp-url">复制</button></div></div><p class="data-share-caption">星图专属接入。使用 Authorization: Bearer &lt;仓库 Key&gt;，仓库由 Key 决定。</p><div class="data-share-endpoints">${endpoints.map(([method,path,label])=>`<div><b>${method}</b><code>${path}</code><span>${label}</span></div>`).join('')}</div><div class="data-share-code-heading"><h4>MCP 客户端配置</h4><button class="text-button" data-share-action="copy" data-kind="mcp-config">复制配置</button></div><pre class="data-share-code"><code>${esc(details.mcpConfiguration?JSON.stringify(details.mcpConfiguration,null,2):"请检查星图 MCP 状态。")}</code></pre><p class="data-share-caption">此为本机接入，使用当前账号连接的盒子，万象客户端需保持运行。空间使用独立的 MCP 地址和空间 Key；本仓 Key 不开放文件空间。</p></section></div><p class="data-share-status" data-share-status role="status"></p><div class="data-dialog-actions"><button class="button" data-share-action="close">完成</button></div>`;
 document.body.append(d);d.showModal();if(startCreate)d.querySelector('.data-share-create').open=true;
 d.addEventListener('close',()=>{disposed=true;clearSecret();if(handle)void call('release-share-key',{handle}).catch(()=>{});d.remove();if(isCurrent())onChanged()},{once:true});
 async function perform(button,task){
  if(!current())return;button.disabled=true;status().textContent='';
  try{await task()}catch(error){if(current()){clearSecret();status().textContent=message(error)}}finally{if(current())button.disabled=false}
 }
 d.addEventListener('click',event=>{
  const b=event.target.closest('[data-share-action]');if(!b)return;
  if(b.dataset.shareAction==='close'){d.close();return}
  void perform(b,async()=>{
   if(b.dataset.shareAction==='copy'){
    const result=await call('copy-share-value',{kind:b.dataset.kind});if(!current())return;
    status().textContent=result.copied?'已复制。':'讨论原型：实际客户端将复制此接口或示例。';
   }else if(b.dataset.shareAction==='manage'){
    await call('open-starlink',{view:'api'});if(current())status().textContent='';
   }else if(b.dataset.shareAction==='reveal'){
    const input=d.querySelector('[data-share-secret]');
    if(input.type==='text'){input.type='password';input.value=newKey.prefix+'••••••••••••';b.textContent='显示'}
    else{const result=await call('reveal-share-key',{handle});if(!current())return;input.type='text';input.value=result.token;b.textContent='隐藏'}
   }else if(b.dataset.shareAction==='copy-key'){
    const result=await call('copy-share-key',{handle});if(current())status().textContent=result.copied?'Key 已复制。':'讨论原型：此为演示 Key，实际客户端将复制真实凭证。';
   }
  });
 });
 d.querySelector('[data-share-create-form]').addEventListener('submit',event=>{
  event.preventDefault();const form=event.target,values=new FormData(form),button=form.querySelector('[type=submit]');
  void perform(button,async()=>{
   const result=await call('create-share-key',{name:String(values.get('name')||''),days:Number(values.get('days'))});
   if(!current()){if(result.handle)void call('release-share-key',{handle:result.handle}).catch(()=>{});return}
   handle=result.handle;newKey=result.key;clearSecret();
   const fresh=d.querySelector('.data-share-new-key');fresh.hidden=false;const input=fresh.querySelector('input');input.type='password';input.value=newKey.prefix+'••••••••••••';fresh.querySelector('[data-share-action="reveal"]').textContent='显示';
   d.querySelector('.data-share-keys').innerHTML=keyList([newKey,...(details.keys||[])]);details.keys=[newKey,...(details.keys||[])];d.querySelector('.data-share-create').open=false;form.reset();
   status().textContent='只读 Key 已生成，请在关闭前复制保存。';
  });
 });
 return d;
}
