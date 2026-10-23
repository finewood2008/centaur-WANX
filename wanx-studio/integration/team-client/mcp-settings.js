// Loaded by the existing renderer; IPC retains clipboard and credential custody.
let wanxMcpInfo=null,wanxMcpError='',wanxMcpScope=null,wanxMcpLoading=false,wanxMcpNotice='';
const wanxMcpScopeNow=()=>JSON.stringify([currentState?.account?.accountId,currentState?.account?.clientId,currentState?.activeDeviceId,currentState?.canLaunchApplications]);
async function loadWanxMcp(){
 const scope=wanxMcpScopeNow();wanxMcpScope=scope;wanxMcpLoading=true;wanxMcpError='';
 try{const r=await window.wanxClient.action('wanx.mcp-details');if(scope!==wanxMcpScopeNow())return;if(!r.ok||typeof r.value?.url!=='string')throw Error(r.code||'MCP_RESPONSE_INVALID');wanxMcpInfo=r.value}
 catch{if(scope===wanxMcpScopeNow())wanxMcpError='暂时无法读取 MCP，请检查当前盒子连接后重试。'}
 finally{if(scope===wanxMcpScopeNow()){wanxMcpLoading=false;if(page==='settings')render(currentState)}}
}
function wanxMcpSettings(){
 const scope=wanxMcpScopeNow();
 if(wanxMcpScope!==scope){wanxMcpScope=scope;wanxMcpInfo=null;wanxMcpError='';wanxMcpNotice='';wanxMcpLoading=false;if(currentState.canLaunchApplications)queueMicrotask(()=>void loadWanxMcp())}
 const info=wanxMcpInfo;
 return `<section class="settings-panel wanx-mcp-settings" aria-label="空间 MCP 设置"><div class="wanx-mcp-title"><div><h3>空间 MCP</h3><p class="muted">独立的空间文件接入，仅开放空间 Key 获准的文件与目录。</p></div><button class="button small" data-action="wanx-mcp-refresh" ${wanxMcpLoading?'disabled':''}>刷新</button></div><div class="wanx-mcp-endpoint"><span>Streamable HTTP</span><code>${escapeHTML(info?.url||(wanxMcpLoading?'正在读取…':'连接盒子后提供地址'))}</code><button class="button small" data-action="wanx-mcp-copy-url" ${!info?'disabled':''}>复制地址</button><button class="button small" data-action="wanx-mcp-copy-config" ${!info?'disabled':''}>复制配置</button></div><p class="muted">Authorization: Bearer &lt;访问 Key&gt; · 本机接入，跟随当前账号与盒子。万象客户端需保持运行。</p><div class="wanx-mcp-resources"><div><strong>空间文件</strong><p>使用空间资源的授权 Key，仅操作获准文件与目录；沿用版本校验、到期和撤销规则。</p><button class="text-button" data-action="show-space">管理空间授权 →</button></div><div><strong>星图 MCP 独立接入</strong><p>星图的地址、配置和仓库 Key 在星图首页管理，与空间 MCP 分开。</p>${teamUIRole==='admin'?'<button class="text-button" data-action="show-data">前往星图 MCP →</button>':'<small>星图接入由团队管理员管理。</small>'}</div></div>${info?.keys?.length?`<div class="wanx-mcp-keys"><strong>现有空间授权 Key</strong>${info.keys.map(k=>`<div><span>${escapeHTML(k.name)} <code>${escapeHTML(k.prefix)}••••••</code><small>${escapeHTML(k.kind)} · ${escapeHTML(k.status)}</small></span><button class="button small" data-action="wanx-mcp-copy-space-key" data-id="${escapeHTML(k.id)}">复制 Key</button></div>`).join('')}</div>`:'<p class="muted">空间访问 Key 可从空间的资源授权中创建。</p>'}<p role="status" class="muted">${escapeHTML(wanxMcpError||wanxMcpNotice)}</p></section>`;
}
app.addEventListener('click',async event=>{
 const button=event.target.closest('[data-action^="wanx-mcp-"]');if(!button||button.disabled)return;event.preventDefault();
 if(button.dataset.action==='wanx-mcp-refresh'){void loadWanxMcp();return}
 const scope=wanxMcpScopeNow();button.disabled=true;
 try{const r=await window.wanxClient.action('wanx.mcp-copy',{kind:button.dataset.action.replace('wanx-mcp-copy-',''),id:button.dataset.id});if(scope!==wanxMcpScopeNow())return;if(!r.ok)throw Error(r.code);wanxMcpNotice='已复制。';wanxMcpError=''}catch{if(scope===wanxMcpScopeNow())wanxMcpError='复制失败，请检查连接及授权是否有效。'}finally{if(scope===wanxMcpScopeNow()&&page==='settings')render(currentState)}
},true);
