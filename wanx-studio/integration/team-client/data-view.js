import {wrapAssistantKnowledgeAccess} from './assistant-knowledge-access.js';
import {selectGraph,layoutGraph,edgeGeometry} from './starlink/graph.mjs';
import {openDataShare} from './data-share-view.js';
window.createTeamDataView=({request,changed})=>{
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const names={queued:'排队中',running:'处理中',processing:'处理中',ready:'正文就绪',succeeded:'已完成',failed:'失败',cancelled:'已取消',active:'可用',importing:'迁入中',clearing:'清理中',deleting:'删除中'};
  const jobNames={document_parse:'材料解析',knowledge_extract:'知识抽取',knowledge_publish:'图谱写入',knowledge_retract:'图谱更新',sensitive_scan:'保护检测',search_index:'检索索引',search_index_build:'检索索引'};
  const stageNames={accepted:'等待处理',retry_queued:'等待重试',completed:'已完成',failed:'处理失败',cancelled:'已取消',publishing:'正在写入图谱',published:'图谱已写入',review_ready:'抽取完成',index_ready:'索引就绪',superseded:'已被新任务取代'};
  const tabs=[['materials','材料'],['graph','知识预览'],['search','证据检索'],['tasks','处理任务']];
  const advanced=[['sensitive','保护规则'],['models','模型与处理'],['skills','Skill 管理'],['reasoning','推理与调用'],['api','接口授权'],['data','迁移与清理']];
  let scope=null,admin=false,epoch=0,loading=false,busy=false,error='',errorCode='',warehouses=[],warehouseId=null,tab='materials',query='',filter='',documents=[],jobs=[],graph={nodes:[],edges:[]},results=[],retrieval=null,node=null,offset=0,total=0,initialized=false;
  let overviewWarehouseId=null,graphError='',graphQuery='',graphType='all',edge=null,zoom=1,graphCache=null;
  let refreshTimer;
  let sharePreview=null,shareError='',shareNotice='';
  const typeInfo={PERSON:['人物','人','#7a91a9'],ORG:['组织','组','#7c967e'],GPE:['地点','地','#7c967e'],EVENT:['事件','事','#7a91a9'],CONCEPT:['概念','知','#b28f93'],DOCUMENT:['材料','文','#7c967e'],PRODUCT:['产品','品','#b89561'],FEATURE:['功能','功','#b89561'],TECHNOLOGY:['技术','技','#b28f93'],DATE:['日期','日','#7a91a9']};
  const relationNames={PREFERS:'情境偏好',FOUNDED:'创办',CREATED:'创建',PART_OF:'属于',HAS_FEATURE:'具有功能',USES:'使用',OCCURRED_AT:'发生于',WORKS_AT:'任职于',LOCATED_IN:'位于'};
  const graphWarehouse=()=>warehouses.find(w=>w.id===(warehouseId||overviewWarehouseId));
  function clearGraph(){graph={nodes:[],edges:[]};graphError='';graphCache=null;node=null;edge=null;zoom=1;graphQuery='';graphType='all'}
  const code=e=>String(e?.code||e?.message||'');
  const message=e=>{
    const c=code(e);
    if(c==='TEAM_DATA_KEY_NOT_REPLAYABLE')return '完整 Key 已不可再次读取，请新建只读 Key 并及时保存。';
    if(c==='TEAM_DATA_KEY_REVOKED')return '此 Key 已撤销或到期，无法继续复制或查看。';
    if(c==='TEAM_DATA_SHARE_INVALID')return '请填写用途名称，并选择 1 至 365 天的有效期。';
    if(c==='TEAM_CLIPBOARD_UNAVAILABLE')return '系统剪贴板暂不可用，请稍后重试。';
    if(c==='SEMANTICA_SERVICE_AUTH_FAILED')return '盒子与星图服务的接入鉴权失败，请管理员检查服务凭据及团队接入版本。';
    if(c==='SEMANTICA_RESOURCE_FORBIDDEN')return '星图服务拒绝访问当前团队数据，请管理员检查团队数据权限与接入配置。';
    if(c==='SEMANTICA_RESOURCE_NOT_FOUND')return '星图服务未找到所请求的资源，请刷新重试；如持续出现，请管理员检查盒端接入版本。';
    if(c==='SEMANTICA_INVALID_REQUEST')return '星图服务未接受当前请求，请管理员检查团队客户端与盒端接入版本是否兼容。';
    return ({SEMANTICA_NOT_CONFIGURED:'当前盒子尚未配置星图服务。',SEMANTICA_SERVICE_UNAVAILABLE:'星图服务暂时不可用，请检查盒子服务后重试。',SEMANTICA_UPGRADE_REQUIRED:'当前盒子需要升级星图接入。',TEAM_STARLINK_NOT_INSTALLED:'尚未安装星图，请到“应用”中安装星图后重试。',APPLICATION_INSTALL_FAILED:'星图安装未完成，请检查应用目录权限后重试。',TEAM_STARLINK_PACKAGE_INVALID:'内置星图安装文件不完整，请重新安装团队客户端。',TEAM_STARLINK_UPGRADE_REQUIRED:'当前星图不支持数据仓定位，请更新星图。',TEAM_STARLINK_OPEN_TIMEOUT:'星图未确认打开目标页面，请检查星图中的连接状态后重试。',TEAM_ADMIN_REQUIRED:'管理员权限已失效，请重新核验团队身份。',SEMANTICA_ADMIN_REQUIRED:'当前账号没有团队数据管理权限。',HOST_SESSION_EXPIRED:'账号或盒子连接已变化，请重新打开数据页。',TEAM_SESSION_CHANGED:'账号或盒子连接已变化，请重新操作。',SPACE_UPGRADE_REQUIRED:'当前盒子不支持空间读取，请升级服务或从本地导入。',SPACE_REMOTE_FILE_CHANGED:'所选空间文件已变化，请重新选择。',MODEL_CLOUD_CONFIRMATION_REQUIRED:'请先在星图的“模型与处理”中确认在线模型使用范围。',WAREHOUSE_BUSY:'数据仓正在迁移或清理，请等待操作完成。'}[c]||'操作未完成，请检查连接、处理任务或星图配置后重试。');
  };
  const call=(action,input={})=>request('data.'+action,input);
  const current=()=>warehouses.find(w=>w.id===warehouseId);
  const badge=v=>`<span class="data-status ${v==='failed'?'failed':v==='active'||v==='succeeded'?'ready':''}">${esc(names[v]||v||'待处理')}</span>`;
  const size=v=>v>=1024*1024?(v/1024/1024).toFixed(1)+' MB':Math.ceil((v||0)/1024)+' KB';
  const loc=v=>{if(!v)return '来源片段';if(typeof v==='string'){try{v=JSON.parse(v)}catch{return v}}return [v.page_number||v.page?`第 ${v.page_number||v.page} 页`:'',v.sheet||v.sheet_name||'',v.paragraph_number?`段落 ${v.paragraph_number}`:'',v.start_seconds!=null?`${v.start_seconds} 秒`:'',v.segment_id||''].filter(Boolean).join(' · ')||'原文片段'};
  function reset(){clearTimeout(refreshTimer);epoch++;warehouses=[];warehouseId=null;overviewWarehouseId=null;documents=[];jobs=[];results=[];clearGraph();sharePreview=null;shareError='';shareNotice='';retrieval=null;loading=false;busy=false;error='';errorCode='';initialized=false;query='';offset=0;total=0;document.querySelectorAll?.('dialog[data-team-data-dialog]').forEach(d=>{d.close();d.remove()})}
  function sync(state,isAdmin){
    admin=isAdmin;
    const next=admin&&state.canLaunchApplications?JSON.stringify([state.account?.accountId,state.account?.clientId,state.activeDeviceId]):null;
    if(next!==scope){reset();scope=next}
  }
  async function refresh(){
    if(!scope||loading)return;clearTimeout(refreshTimer);const version=epoch;loading=true;error='';errorCode='';changed();
    try{
      const listing=await call('warehouses');if(version!==epoch)return;
      if(!Array.isArray(listing?.items))throw Error('TEAM_DATA_RESPONSE_INVALID');
      warehouses=listing.items;initialized=true;
      if(warehouseId&&!current()){warehouseId=null;documents=[];jobs=[];clearGraph();results=[]}
      if(!warehouses.some(w=>w.id===overviewWarehouseId)){overviewWarehouseId=(warehouses.find(w=>w.entity_count>0)||warehouses[0])?.id||null;clearGraph()}
      if(warehouseId){
        const input={warehouseId,offset};
        const result=await call(tab==='materials'?'documents':tab==='tasks'?'jobs':tab==='graph'?'graph':'retrieval',input);
        if(version!==epoch)return;
        if(tab==='materials'){documents=result.items||result.documents||[];total=result.total??documents.length}
        else if(tab==='tasks'){jobs=result.items||result.jobs||[];total=result.total??jobs.length}
        else if(tab==='graph'){graph=result;graphError=''}
        else retrieval=result;
      }else if(overviewWarehouseId){
        try{const result=await call('graph',{warehouseId:overviewWarehouseId});if(version!==epoch)return;graph=result;graphError=''}
        catch(e){if(version!==epoch)return;if(/ADMIN_REQUIRED|SESSION/.test(code(e)))throw e;graphError=message(e);graph={nodes:[],edges:[]};graphCache=null}
      }
      const shareWid=warehouseId||overviewWarehouseId;
      if(shareWid){
        try{const value=await call('share-details',{warehouseId:shareWid});if(version!==epoch)return;if(typeof value?.hostBase!=='string'||!Array.isArray(value.keys))throw Error('TEAM_DATA_RESPONSE_INVALID');sharePreview={...value,warehouseId:shareWid};shareError=''}
        catch(e){if(version!==epoch)return;if(/ADMIN_REQUIRED|SESSION/.test(code(e)))throw e;sharePreview=null;shareError=message(e)}
      }else{sharePreview=null;shareError=''}
    }catch(e){if(version===epoch){error=message(e);errorCode=code(e);if(/ADMIN_REQUIRED|SESSION/.test(code(e))){warehouses=[];documents=[];jobs=[];results=[];clearGraph();sharePreview=null;shareError='';warehouseId=null;overviewWarehouseId=null}}}
    finally{if(version===epoch){loading=false;changed();if(!error&&warehouses.some(w=>w.active_jobs>0))refreshTimer=setTimeout(()=>void refresh(),3000)}}
  }
  function btn(label,action,extra='',primary=false){return `<button class="button ${primary?'primary':''}" data-data-action="${action}" ${extra} ${busy?'disabled':''}>${label}</button>`}
  function empty(title,body=''){return `<div class="data-empty"><span aria-hidden="true">◈</span><h3>${esc(title)}</h3><p>${esc(body)}</p></div>`}
  function overview(){
    const list=warehouses.filter(w=>(w.name+' '+w.description).toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
    return `<div class="data-workbench">${graphPage(true)}<aside class="data-warehouse-rail" aria-label="团队数据仓"><header><h3>团队数据仓 <span>${warehouses.length}</span></h3></header><form data-data-form="filter"><input data-studio-edit-key="team-data-filter" name="filter" value="${esc(filter)}" placeholder="搜索数据仓" aria-label="搜索数据仓"><button class="button" aria-label="搜索数据仓">⌕</button></form><div class="data-warehouse-list">${list.map(w=>`<button class="data-warehouse-choice ${w.id===overviewWarehouseId?'active':''}" data-data-action="graph-warehouse" data-id="${esc(w.id)}" ${w.id===overviewWarehouseId?'aria-current="true"':''}><span class="data-warehouse-choice-icon" aria-hidden="true">◈</span><span><strong>${esc(w.name)}</strong><small>${w.document_count||0} 材料 <i>·</i> ${w.entity_count||0} 实体</small>${w.active_jobs?`<em>${w.active_jobs} 项处理中</em>`:''}</span><span class="data-warehouse-arrow">›</span></button>`).join('')}${!list.length&&!loading?`<p class="data-rail-empty">${warehouses.length?'未找到匹配数据仓':'新建数据仓，开始整理团队知识。'}</p>`:''}</div><div class="data-rail-bottom"><p>团队知识概况</p><section class="data-summary">${[[warehouses.length,'数据仓'],[warehouses.reduce((n,w)=>n+(w.document_count||0),0),'材料'],[warehouses.reduce((n,w)=>n+(w.entity_count||0),0),'知识实体'],[warehouses.reduce((n,w)=>n+(w.active_jobs||0),0),'处理中']].map(([n,l])=>`<div><strong>${n}</strong><span>${l}</span></div>`).join('')}</section><p class="data-rail-shared"><span></span>团队管理员共同维护</p></div></aside></div>`;
  }
  function warehouseAccess(){
    const w=current();if(!w)return '';
    const details=sharePreview?.warehouseId===w.id?sharePreview:null,keys=details?.keys||[],active=keys.filter(k=>!k.revoked_at&&Number(k.expires_at)*1000>Date.now()),attrs=`data-warehouse-id="${esc(w.id)}"`;
    return `<section class="data-warehouse-access" aria-label="当前仓库的访问 Key"><header><div><h3>仓库访问 Key <span>${details?active.length+' 个有效':'读取中…'}</span></h3><p>仅授权「${esc(w.name)}」，不包含其他数据仓或空间文件。</p></div>${btn('＋ 生成仓库 Key','share-create',attrs,true)}</header>${details?keys.length?`<div class="data-warehouse-key-list">${keys.map(k=>{const valid=active.includes(k);return `<article><div><strong>${esc(k.name)}</strong><code>${esc(k.prefix)}••••••</code><small>${esc((k.scopes||[]).map(v=>({documents:'材料',graph:'图谱',evidence:'证据',search:'检索',reasoning:'推理'})[v]||v).join(' · '))}</small></div><span>${k.revoked_at?'已撤销':valid?'有效':'已到期'} · ${k.expires_at?new Date(Number(k.expires_at)*1000).toLocaleDateString('zh-CN')+' 到期':'—'}</span></article>`}).join('')}</div><p class="data-key-caption">已有 Key 仅显示前缀；完整值在新建时提供。</p>`:'<p class="data-key-caption">此仓库尚未生成 Key。生成后可通过星图 MCP 读取本仓知识。</p>':`<p class="data-key-caption">${esc(shareError||'正在读取此仓库的 Key…')}${shareError?btn('重试','refresh'):''}</p>`}</section>`;
  }
  function mcpFooter(){
    const w=graphWarehouse();if(!w)return '';
    const details=sharePreview?.warehouseId===w.id?sharePreview:null,attrs=`data-warehouse-id="${esc(w.id)}"`;
    return `<section class="data-mcp-footer" aria-label="星图 MCP 接入"><div class="data-mcp-footer-heading"><div><h3>星图 MCP</h3><p>${current()?'使用此仓库的 Key 接入，授权范围以 Key 为准。':'访问 Key 绑定单个数据仓，请进入数据仓生成。'}</p></div>${current()?btn('接入配置','share',attrs):btn('进入数据仓 →','select',`data-id="${esc(w.id)}"`)}</div><div class="data-mcp-footer-address"><code>${esc(details?.mcpUrl||(shareError?'MCP 读取失败':details?'MCP 暂不可用':'正在读取 MCP…'))}</code>${details?.mcpUrl?btn('复制 MCP 地址','copy-home-interface',attrs):btn('重试','refresh')}</div><small>星图独立接入 · 本机使用 · 万象客户端需保持运行</small>${shareNotice?`<p class="data-mcp-footer-notice" role="status">${esc(shareNotice)}</p>`:''}</section>`;
  }
  function materialPage(){
    return `<div class="data-section-heading"><p>正文就绪后还需知识抽取与图谱写入；进度和失败原因可在「处理任务」查看。</p><div>${btn('从本地导入','import-local')}${btn('从空间导入','import-space','',true)}</div></div><div class="data-table-scroll"><table class="data-table"><thead><tr><th>材料</th><th>正文状态</th><th>来源</th><th></th></tr></thead><tbody>${documents.map(d=>`<tr><td><strong>${esc(d.original_name)}</strong><small>${esc(String(d.document_format||'').toUpperCase())} · ${size(d.size_bytes)}</small></td><td>${badge(d.job_status==='failed'?'failed':d.status)}</td><td>${String(d.external_document_id||'').startsWith('wanx-space:')?'万象空间':'导入材料'}</td><td><button class="text-button" data-data-action="source" data-id="${esc(d.id)}">查看来源</button></td></tr>`).join('')}</tbody></table></div>${!documents.length&&!loading?empty('尚未导入材料','支持文档、表格、图片和音频；具体格式以当前盒子能力为准。'):''}${pagination()}`;
  }
  function pagination(){return total>100?`<div class="data-pagination">${btn('上一页','previous',offset?'':'disabled')}<span>${offset+1}–${Math.min(offset+100,total)} / ${total}</span>${btn('下一页','next',offset+100<total?'':'disabled')}</div>`:''}
  function graphPage(hero=false){
    const w=graphWarehouse(),key=JSON.stringify([graph,graphQuery,graphType,node]);
    if(graphCache?.key!==key){
      const raw={nodes:(graph.nodes||[]).map(n=>({...n,id:String(n.entity_id||n.id),name:String(n.canonical_name||n.name||'未命名实体'),type:typeInfo[n.entity_type]?n.entity_type:'CONCEPT'})),edges:(graph.edges||[]).map((e,i)=>({...e,id:String(e.fact_id||e.id||i),s:String(e.subject_entity_id),t:String(e.object_entity_id),label:relationNames[e.relation_type]||e.relation_type||'关联',evidence:e.evidence||[]}))};
      graphCache={key,raw,value:layoutGraph(selectGraph(raw,{query:graphQuery,type:graphType,focus:node}))};
    }
    const {raw,value:g}=graphCache,ids=new Map(g.nodes.map(n=>[n.id,n])),selected=raw.nodes.find(n=>n.id===node),selectedEdge=raw.edges.find(e=>e.id===edge),related=selectedEdge?[selectedEdge]:raw.edges.filter(e=>e.s===node||e.t===node),groups=new Map();
    for(const e of g.edges){const key=JSON.stringify([e.s,e.t].sort());if(!groups.has(key))groups.set(key,[]);groups.get(key).push(e.id)}
    const bounds=g.nodes.length?{left:Math.min(...g.nodes.map(n=>n.x-Math.max(n.r+18,n.labelWidth/2+18))),right:Math.max(...g.nodes.map(n=>n.x+Math.max(n.r+18,n.labelWidth/2+18))),top:Math.min(...g.nodes.map(n=>n.y-n.r-26)),bottom:Math.max(...g.nodes.map(n=>n.y+n.r+28+n.lines.length*15))}:{left:0,right:800,top:0,bottom:540};
    const scale=Math.max((bounds.right-bounds.left)/740,(bounds.bottom-bounds.top)/450,0.6)/zoom,vw=800*scale,vh=540*scale,cx=(bounds.left+bounds.right)/2,cy=(bounds.top+bounds.bottom)/2;
    const facts=related.map(e=>`<article><b>${esc(raw.nodes.find(n=>n.id===e.s)?.name)} → ${esc(e.label)} → ${esc(raw.nodes.find(n=>n.id===e.t)?.name)}</b>${e.evidence.map(v=>`<p>${esc(v.excerpt)}</p><button class="text-button" data-data-action="source" data-id="${esc(v.document_id)}" data-warehouse-id="${esc(w?.id)}">查看来源 · ${esc(loc(v.locator_json||v.locator))}</button>`).join('')||'<p>当前关系暂无可展示的原文片段。</p>'}</article>`).join('');
    const picker=`<span class="data-graph-mode">只读预览</span>${hero&&w?btn('管理材料 →','select',`data-id="${esc(w.id)}"`):''}`;
    const emptyText=graphError||(!initialized&&loading?'正在读取团队知识图谱…':!w?'建立第一座团队数据仓，让资料开始相连。':raw.nodes.length?'没有找到匹配的实体，请调整搜索或返回全图。':w.document_count>0?`已导入 ${w.document_count} 份材料，知识图谱尚未生成。请查看知识抽取与图谱写入的处理结果。`:'这个仓的知识图谱，从第一份资料开始。导入后，处理模型会提取实体与关系。');
    return `<section class="data-core-graph ${hero?'is-hero':''}" aria-label="核心知识图谱"><header class="data-core-heading"><div><h3>核心知识图谱</h3><p>${esc(w?.name||'团队知识从这里开始')}</p></div><div class="data-core-actions">${picker}</div></header><div class="data-core-toolbar"><form data-data-form="graph-search"><input data-studio-edit-key="team-data-graph-query" name="graphQuery" value="${esc(graphQuery)}" placeholder="查找实体，探索知识关联" aria-label="查找图谱实体"><button class="button">查找</button></form><div class="data-graph-filters" aria-label="图谱实体类型">${[['all',['全部']],...Object.entries(typeInfo).filter(([t])=>raw.nodes.some(n=>n.type===t))].map(([t,info])=>`<button data-data-action="graph-type" data-type="${t}" aria-pressed="${graphType===t}" class="${graphType===t?'active':''}">${info[2]?`<i style="background:${info[2]}"></i>`:''}${info[0]}</button>`).join('')}</div>${node||graphQuery||graphType!=='all'?btn('返回全图','graph-reset'):''}</div><div class="data-core-body"><div class="data-core-canvas"><svg class="data-graph" viewBox="${cx-vw/2} ${cy-vh/2} ${vw} ${vh}" role="group" aria-label="${esc(w?.name||'团队数据仓')}知识图谱"><defs><marker id="team-graph-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M1 1 L5 3.5 L1 6" fill="none" stroke="#9aabbb" stroke-width=".8"/></marker></defs>${g.edges.map(e=>{const a=ids.get(e.s),b=ids.get(e.t),group=groups.get(JSON.stringify([e.s,e.t].sort())),path=edgeGeometry(a,b,group.indexOf(e.id),group.length),chosen=e.id===edge;return `<g class="data-graph-link ${chosen?'chosen':''}"><title>${esc(a.name)} → ${esc(e.label)} → ${esc(b.name)}</title><path class="data-edge-hit" d="${path.d}" data-data-action="edge" data-id="${esc(e.id)}" role="button" tabindex="0" aria-label="查看关系 ${esc(a.name+' '+e.label+' '+b.name)}"/><path class="data-edge" d="${path.d}" marker-end="url(#team-graph-arrow)"/>${chosen||node||g.edges.length<=12?`<text class="data-edge-label" transform="translate(${path.x} ${path.y}) rotate(${path.angle})" text-anchor="middle" y="-7">${esc(e.label)}</text>`:''}</g>`}).join('')}${g.nodes.map(n=>`<g class="data-core-node ${n.id===node?'selected':''}" style="--type-color:${typeInfo[n.type][2]}" transform="translate(${n.x} ${n.y})" role="button" tabindex="0" data-data-action="node" data-id="${esc(n.id)}" aria-label="查看实体 ${esc(n.name)}"><title>${esc(n.name)} · ${typeInfo[n.type][0]}</title><circle class="halo" r="${n.r+8}"/><circle class="core" r="${n.r}"/><text class="node-symbol" dy="5">${typeInfo[n.type][1]}</text><text class="node-name" y="${n.r+20}">${n.lines.map((line,i)=>`<tspan x="0" dy="${i?15:0}">${esc(line)}</tspan>`).join('')}</text></g>`).join('')}</svg>${!g.nodes.length?`<div class="data-core-empty" ${graphError?'role="alert"':''}><span aria-hidden="true">◈</span><p>${esc(emptyText)}</p>${graphError?btn('重新读取','refresh'):w&&!raw.nodes.length&&!loading?btn(w.document_count>0?'查看处理任务':'导入材料','select',`data-id="${esc(w.id)}" ${w.document_count>0?'data-tab="tasks"':''}`):''}</div>`:''}<div class="data-core-tools">${btn('−','graph-zoom','data-direction="out" aria-label="缩小知识图谱"')}<output>${Math.round(zoom*100)}%</output>${btn('＋','graph-zoom','data-direction="in" aria-label="放大知识图谱"')}${btn('适应画布','graph-fit')}</div><p class="data-core-hint">点击实体聚焦关联 · 点击连线查看来源</p></div><aside class="data-graph-evidence"><p class="data-detail-eyebrow">${selectedEdge?'关系证据':selected?typeInfo[selected.type][0]:'探索知识'}</p><h3>${esc(selected?.name||(selectedEdge?'查看关系来源':'从一个实体开始'))}</h3>${selected||selectedEdge?facts||'<p>当前实体暂无可展示的关系证据。</p>':`<p>点击图中实体，探索它与团队知识的联系。</p><div class="data-graph-starts">${g.nodes.filter(n=>n.degree>0).slice(0,4).map(n=>`<button data-data-action="node" data-id="${esc(n.id)}"><span>${esc(n.name)}<small>${typeInfo[n.type][0]} · ${n.degree} 条关联</small></span><span>→</span></button>`).join('')}</div><p class="data-core-detail-note">深度编辑与完整图谱<br>在星图中继续操作 ↗</p>`}</aside></div><footer class="data-core-footer"><span><b>${g.nodes.length}</b> 个实体 <b>${g.edges.length}</b> 条关系 <b>${new Set(g.edges.flatMap(e=>e.evidence.map(v=>v.document_id)).filter(Boolean)).size}</b> 份引用材料</span><span>${node?'实体直接关联':'当前数据仓 · 最多 120 个实体'}</span></footer></section>`;
  }
  function searchPage(){return `<form class="data-search" data-data-form="search"><input data-studio-edit-key="team-data-search" name="query" value="${esc(query)}" placeholder="针对当前数据仓，输入你想查找的问题" aria-label="证据检索问题" required maxlength="2000"><button class="button primary" ${loading?'disabled':''}>${loading?'检索中…':'检索证据'}</button></form><p class="muted">结果遵循数据仓保护规则，保留引用片段与来源定位。</p>${results.map(r=>`<article class="data-search-result"><div><strong>${esc(r.document_name||r.original_name||r.document_id)}</strong><small>${esc(loc(r.locator))}</small></div><p>${esc(r.text||r.excerpt)}</p><button class="text-button" data-data-action="source" data-id="${esc(r.document_id)}">查看原文来源 →</button></article>`).join('')}${!results.length&&!loading?empty(query?'未找到可交付的证据':'带着具体问题查找团队知识','如材料尚未完成索引或保护检测，请在星图中查看处理状态。'):''}`}
  const failedPublications=()=>jobs.filter(j=>j.kind==='knowledge_publish'&&j.status==='failed');
  function failedExtractions(){
    const latest=new Map();
    for(const job of jobs){if(job.kind!=='knowledge_extract'||!job.document_id)continue;const old=latest.get(job.document_id);if(!old||String(job.created_at||'')>String(old.created_at||''))latest.set(job.document_id,job)}
    return [...latest.values()].filter(j=>j.status==='failed'&&j.error_code!=='STALE_EXTRACTION_GENERATION');
  }
  function taskPage(){return `${failedExtractions().length?`<div class="data-section-heading"><p>${failedExtractions().length} 份材料的最新知识抽取未完成。原任务重试保留旧模型；也可确认后使用当前数据仓模型重新处理。</p>${btn('用当前模型补处理（'+failedExtractions().length+'）','reprocess-failed')}</div>`:''}${failedPublications().length?`<div class="data-section-heading"><p>${failedPublications().length} 份材料已完成抽取，但图谱写入失败；恢复图数据库后可重试，无需再次调用抽取模型。</p>${btn('重试图谱写入（'+failedPublications().length+'）','retry-publications')}</div>`:''}${jobs.map(j=>`<article class="data-task"><div><strong>${esc(j.document_name||j.document_id||'数据仓处理任务')}</strong><p>${esc(jobNames[j.kind]||j.kind)} · ${esc(stageNames[j.stage]||j.stage)}${j.total_units?' · '+j.completed_units+'/'+j.total_units:''}</p>${j.error_message?`<p class="data-error-text">${esc(j.error_message)}</p>`:''}</div><div>${badge(j.status)}${(j.status==='failed'||j.status==='cancelled')&&!['STALE_EXTRACTION_GENERATION','SUPERSEDED','INDEX_CHANGED'].includes(j.error_code)?btn('重试','retry',`data-id="${esc(j.id)}"`):''}</div></article>`).join('')}${!jobs.length&&!loading?empty('暂无处理任务','导入材料后，任务进度会显示在这里。'):''}${pagination()}`}
  function render(){
    if(!admin)return empty('仅管理员可管理团队数据');
    if(!scope)return empty('请先连接团队盒子','连接后读取当前团队的数据仓。');
    const w=current(),gw=graphWarehouse(),target={warehouseId:w?.id||gw?.id,view:w?tab:gw?'graph':'warehouses'};
    return `<section class="team-data-page"><header class="data-page-bar"><div class="data-page-title"><span class="data-page-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M8 9L23 7 24 23 8 24 8 9 24 23M8 24L23 7"/><circle cx="8" cy="9" r="3"/><circle cx="23" cy="7" r="3"/><circle cx="24" cy="23" r="3"/><circle cx="8" cy="24" r="3"/></svg></span><div><h2>万象·星图 <span class="feature-beta">Beta</span><span>WanX Starlink</span></h2><p>让团队资料相连，成为可追溯的知识。</p></div></div><div class="data-page-actions">${btn(loading?'读取中…':'刷新','refresh')}${btn('打开万象·星图 ↗','open',`data-view="${target.view}" ${target.warehouseId?`data-warehouse-id="${esc(target.warehouseId)}"`:''}`)}${btn('＋ 新建数据仓','create','',true)}</div></header>${error?`<div class="data-error" role="alert">${esc(error)} ${/TEAM_STARLINK_(NOT_INSTALLED|UPGRADE_REQUIRED)/.test(errorCode)?btn('安装／更新星图','install-starlink'):btn('重试','refresh')}</div>`:''}${loading?'<div class="data-loading" role="status">正在读取当前团队的数据…</div>':''}${w?`<div class="data-warehouse-detail"><div class="data-breadcrumb"><button class="text-button" data-data-action="overview">全部数据仓</button><span>/</span><strong>${esc(w.name)}</strong>${badge(w.state)}</div><nav class="data-tabs" aria-label="数据仓功能">${tabs.map(([id,label])=>`<button class="${tab===id?'active':''}" data-data-action="tab" data-tab="${id}" ${tab===id?'aria-current="page"':''}>${label}</button>`).join('')}</nav>${tab==='materials'?materialPage():tab==='graph'?graphPage():tab==='search'?searchPage():taskPage()}${warehouseAccess()}<section class="data-advanced"><div><h3>星图专业工具</h3><p>沿用当前团队与数据仓。</p></div><div>${advanced.map(([id,label])=>btn(label+' ↗','open',`data-view="${id}"`)).join('')}</div></section></div>`:overview()}${mcpFooter()}<footer class="data-footnote">团队共享知识 · 内部应用按数据仓授权使用</footer></section>`;
  }
  function dialog(title,body,onSubmit){
    const version=epoch,d=document.createElement('dialog');d.dataset.teamDataDialog='';d.className='data-dialog';d.innerHTML=`<form><div class="data-dialog-heading"><h3>${esc(title)}</h3><button type="button" data-close aria-label="关闭">×</button></div>${body}<p class="data-dialog-error" role="alert"></p><div class="data-dialog-actions"><button type="button" class="button" data-close>取消</button><button type="submit" class="button primary">确认</button></div></form>`;document.body.append(d);d.showModal();
    d.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>d.close());d.onclose=()=>d.remove();
    d.querySelector('form').onsubmit=async e=>{e.preventDefault();const b=d.querySelector('[type=submit]');b.disabled=true;try{if(version!==epoch)throw Error('TEAM_SESSION_CHANGED');await onSubmit(new FormData(e.target),d);if(version!==epoch)return;d.close();await refresh()}catch(e){d.querySelector('.data-dialog-error').textContent=message(e)}finally{b.disabled=false}};
    return d;
  }
  async function importFiles(files){
    if(!files?.length)return;const version=epoch,wid=warehouseId;
    let processing;try{processing=await call('processing',{warehouseId:wid})}catch{}
    if(version!==epoch)return;
    const model=processing?.effective?.extraction||processing?.config?.extraction||processing?.extraction;
    const d=dialog('导入到 '+current().name,`<p>导入 ${files.length} 份材料，生成可追溯的正文与知识。${esc(model?.model||model?.label||'处理模型沿用当前数据仓配置。')}</p><p>若本仓配置在线模型，正文片段将发送到已确认的模型服务。模型调整与服务确认请在星图中完成。</p><ul>${files.map(f=>`<li>${esc(f.name)} · ${size(f.size)}</li>`).join('')}</ul><label class="data-confirm"><input type="checkbox" name="confirmed" required>已确认材料范围及本仓的处理配置</label><p class="data-upload-state" role="status"></p>`,async(_,dialog)=>{
      for(let i=0;i<files.length;i++){if(version!==epoch||wid!==warehouseId)throw Error('TEAM_SESSION_CHANGED');dialog.querySelector('.data-upload-state').textContent=`正在导入 ${i+1}/${files.length}：${files[i].name}`;await call('upload',{warehouseId:wid,handle:files[i].handle})}
    });
    d.addEventListener('close',()=>{if(version===epoch)void call('release-files',{warehouseId:wid,handles:files.map(f=>f.handle)}).catch(()=>{})});
  }
  async function spacePicker(){
    const version=epoch,wid=warehouseId;let listing,sequence=0;const picks=new Map();
    const d=dialog('从万象空间导入',`<p>选择当前账号有权读取的文件，导入为团队知识材料。</p><div class="data-space-breadcrumb"></div><div class="data-space-files">正在读取空间…</div>`,async()=>{if(version!==epoch||wid!==warehouseId)throw Error('TEAM_SESSION_CHANGED');if(!picks.size)return;const files=await call('select-space-files',{warehouseId:wid,entries:[...picks.values()]});d.close();await importFiles(files)});
    async function load(parent=''){
      const seq=++sequence;
      try{const v=await call('space-list',{parent});if(version!==epoch||seq!==sequence||!d.isConnected)return;listing=v;
        d.querySelector('.data-space-breadcrumb').innerHTML=`<button type="button" data-folder="">根目录</button>${(v.breadcrumbs||[]).map(b=>`<button type="button" data-folder="${esc(b.id)}">/ ${esc(b.name)}</button>`).join('')}`;
        d.querySelector('.data-space-files').innerHTML=(v.items||[]).map(f=>f.kind==='folder'?`<button type="button" class="data-space-folder" data-folder="${esc(f.id)}">▱ ${esc(f.name)} →</button>`:`<label><input type="checkbox" data-file="${esc(f.id)}" ${picks.has(f.id)?'checked':''} ${f.problem?'disabled':''}>${esc(f.name)}<small>${f.problem?esc(f.problem):size(f.size)}</small></label>`).join('')||'<p>此文件夹为空。</p>';
      }catch(e){d.querySelector('.data-dialog-error').textContent=message(e)}
    }
    d.addEventListener('click',e=>{const b=e.target.closest('[data-folder]');if(b)void load(b.dataset.folder)});
    d.addEventListener('change',e=>{if(e.target.dataset.file){const f=listing.items.find(f=>f.id===e.target.dataset.file);if(e.target.checked)picks.set(f.id,{id:f.id,digest:f.digest});else picks.delete(f.id)}});
    await load();
  }
  async function source(id,wid=warehouseId){
    const version=epoch,v=await call('document',{warehouseId:wid,id});if(version!==epoch)return;
    const d=dialog(v.document?.original_name||'材料来源',`<p>只读原文 · 版本 ${esc(v.version?.id||v.document?.active_version_id||'待解析')}</p><div class="data-source">${(v.segments||[]).map(s=>`<article><small>${esc(loc(s.source_locator||s.locator))}</small><p>${esc(s.text||s.content)}</p></article>`).join('')||'<p>正文尚未就绪，请查看处理任务。</p>'}</div><p>需要校对、查看完整版本或原件时，请在星图中打开当前数据仓。</p>`,async()=>{});d.querySelector('[type=submit]').textContent='关闭';
  }
  async function action(name,data={}){
    if(!scope||!admin)return;
    if(name==='graph-warehouse'){
      if(!warehouses.some(w=>w.id===data.id))return;
      epoch++;loading=false;overviewWarehouseId=data.id;clearGraph();sharePreview=null;shareError='';shareNotice='';changed();await refresh();return;
    }
    if(name==='create'){dialog('新建团队数据仓','<label>名称<input name="name" required maxlength="60" placeholder="如：产品与客户资料"></label><label>说明<textarea name="description" maxlength="500" placeholder="这个数据仓存放哪些资料？"></textarea></label>',async f=>call('create-warehouse',{name:f.get('name'),description:f.get('description')}));return}
    if(name==='select'||name==='overview'||name==='tab'){
      epoch++;loading=false;documents=[];jobs=[];results=[];clearGraph();sharePreview=null;shareError='';shareNotice='';error='';errorCode='';query='';offset=0;total=0;
      if(name==='select'){warehouseId=data.id;tab=data.tab==='tasks'?'tasks':'materials'}else if(name==='overview')warehouseId=null;else tab=data.tab;
      await call('select-warehouse');changed();await refresh();return;
    }
    if(name==='node'){node=data.id;edge=null;zoom=1;changed();return}
    if(name==='edge'){edge=data.id;changed();return}
    if(name==='graph-reset'){node=null;edge=null;graphQuery='';graphType='all';zoom=1;changed();return}
    if(name==='graph-type'){graphType=data.type;node=null;edge=null;zoom=1;changed();return}
    if(name==='graph-zoom'){zoom=Math.min(2.5,Math.max(.5,zoom+(data.direction==='in'?.25:-.25)));changed();return}
    if(name==='graph-fit'){zoom=1;changed();return}
    if(name==='refresh'){await refresh();return}
    if(name==='previous'||name==='next'){offset=Math.max(0,offset+(name==='next'?100:-100));await refresh();return}
    if(name==='source'){try{await source(data.id,data.warehouseId||warehouseId)}catch(e){error=message(e);errorCode=code(e);changed()}return}
    if(name==='reprocess-failed'){
      if(busy)return;
      const version=epoch,wid=warehouseId,ids=new Set(failedExtractions().map(j=>j.document_id));
      if(!wid||!ids.size)return;
      busy=true;error='';errorCode='';changed();
      try{
        const processing=await call('processing',{warehouseId:wid});
        const listing=await call('documents',{warehouseId:wid,offset:0});
        if(version!==epoch)return;
        const selected=(listing.items||listing.documents||[]).filter(d=>ids.has(d.id)&&d.status==='ready'&&d.active_version_id);
        if(!selected.length)throw Error('TEAM_DATA_RESPONSE_INVALID');
        const config=processing.effective||processing.config||processing,model=config.extraction;
        if(!model||typeof config.signature!=='string')throw Error('TEAM_DATA_RESPONSE_INVALID');
        dialog('使用当前模型补处理',`<p>仅重新处理 ${selected.length} 份未完成知识抽取的材料，保留其他材料的现有图谱。</p><p>当前模型：${esc(model?.name||model?.model||'当前数据仓处理模型')}。${model?.location==='external'?'正文片段将发送到已确认的在线模型服务，并产生模型用量。':'沿用当前数据仓已确认的处理配置。'}</p><ul>${selected.map(d=>`<li>${esc(d.original_name)}</li>`).join('')}</ul><label class="data-confirm"><input type="checkbox" required>确认上述材料范围与当前模型</label>`,async()=>{
          await call('reprocess-models',{warehouseId:wid,documents:selected.map(d=>({id:d.id,version_id:d.active_version_id})),expectedSignature:config.signature});
        });
      }catch(e){if(version===epoch){error=message(e);errorCode=code(e)}}finally{if(version===epoch){busy=false;changed()}}
      return;
    }
    if(busy)return;
    const version=epoch;busy=true;error='';errorCode='';changed();
    try{
      if(name==='share'||name==='share-create'){const w=current();if(!w||data.warehouseId&&data.warehouseId!==w.id)return;await openDataShare({warehouse:w,request,isCurrent:()=>version===epoch&&warehouseId===w.id&&Boolean(scope)&&admin,message,startCreate:name==='share-create',onChanged:()=>{if(version===epoch&&warehouseId===w.id&&scope&&admin)void refresh()}})}
      else if(name==='copy-home-interface'){const wid=data.warehouseId||warehouseId||overviewWarehouseId;if(wid!==graphWarehouse()?.id)return;const value=await call('copy-share-value',{warehouseId:wid,kind:'mcp-url'});if(version===epoch)shareNotice=value.copied?'星图 MCP 地址已复制。':'讨论原型：实际客户端将复制星图 MCP 地址。'}
      else if(name==='install-starlink'){await call('install-starlink');await call('open-starlink',{warehouseId,view:warehouseId?tab:'warehouses'})}
      else if(name==='open')await call('open-starlink',{warehouseId:data.warehouseId||warehouseId,view:data.view||tab});
      else if(name==='import-local')await importFiles(await call('select-files',{warehouseId}));
      else if(name==='import-space')await spacePicker();
      else if(name==='retry'){await call('retry-job',{warehouseId,id:data.id});await refresh()}
      else if(name==='retry-publications'){
        const wid=warehouseId,pending=failedPublications().map(j=>j.id);
        for(const id of pending){if(version!==epoch||!scope||!admin)return;await call('retry-job',{warehouseId:wid,id})}
        if(version===epoch)await refresh();
      }
    }catch(e){if(version===epoch){error=message(e);errorCode=code(e)}}finally{if(version===epoch){busy=false;changed()}}
  }
  async function submit(kind,form){
    if(!scope||!admin)return;
    if(kind==='graph-search'){graphQuery=String(form.get('graphQuery')||'').trim();node=null;edge=null;zoom=1;changed();return}
    if(kind==='filter'){filter=form.get('filter')||'';changed();return}
    if(kind==='search'){
      query=String(form.get('query')||'').trim();if(!scope||!query)return;
      const version=epoch;loading=true;results=[];error='';errorCode='';changed();
      try{const v=await call('search',{warehouseId,query});if(version===epoch)results=v.items||v.results||[]}
      catch(e){if(version===epoch){error=message(e);errorCode=code(e)}}finally{if(version===epoch){loading=false;changed()}}
    }
  }
  return {sync,render,refresh,action,submit,input:(name,value)=>{if(name==='query')query=value;if(name==='filter')filter=value;if(name==='graphQuery')graphQuery=value},needsLoad:()=>scope&&!initialized&&!loading&&!error};
};

window.createTeamDataView=wrapAssistantKnowledgeAccess(window.createTeamDataView);
