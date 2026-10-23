window.createTeamView=({request,changed})=>{
  let key=null,identity=null,error=null,catalog=[],members=[],projects=[],invites=[],timer=null,loading=false,epoch=0,management=false;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const message=e=>({TEAM_PUBLISHING_UNAVAILABLE:'当前盒子尚未启用团队上架，请连接已升级的团队服务器。',TEAM_SERVICE_UNAVAILABLE:'当前盒子尚未提供所需团队能力。',TEAM_ADMIN_REQUIRED:'此操作仅限管理员。',TEAM_LOGIN_DENIED:'账号、密码或授权无效，请重新核对。',TEAM_SERVER_HTTPS_REQUIRED:'公网服务器请使用 HTTPS 地址。',TEAM_MEMBERS_REQUIRED:'请至少选择一名有效成员。',USER_ADOPTION_REQUIRED:'请先在构建工作台确认采用此版本。',USER_ACCEPTANCE_REQUIRED:'请先完成版本验收。',TEAM_SESSION_CHANGED:'连接或账号已变化，请重新操作。'}[String(e.message).match(/(?:TEAM|USER|STUDIO)_[A-Z_]+/)?.[0]]||'操作未完成，请检查连接或当前账号权限后重试。');
  async function call(op,input){return request('team.'+op,input||{})}
  async function refresh(){
    if(!key||loading)return;
    const revision=epoch;loading=true;queueMicrotask(()=>{if(revision===epoch)changed()});
    try{
      const next=await call('identity');if(revision!==epoch)return;identity=next;error=null;
      try{const apps=await call('catalog');if(revision!==epoch)return;catalog=apps}catch(e){if(revision!==epoch)return;catalog=[];error=message(e)}
      if(management&&identity.role==='admin'){
        const rows=await Promise.all([call('members'),call('projects'),call('invites')]);if(revision!==epoch)return;[members,projects,invites]=rows;
      }
    }catch(e){if(revision!==epoch)return;identity=null;error=message(e);catalog=[];members=[];projects=[];invites=[]}
    finally{if(revision===epoch){loading=false;changed()}}
  }
  function sync(state){
    const next=state.canLaunchApplications?JSON.stringify([state.account?.accountId,state.account?.clientId,state.activeDeviceId]):null;
    if(next===key)return;
    epoch++;key=next;identity=null;catalog=[];members=[];projects=[];invites=[];error=null;loading=false;management=false;clearInterval(timer);timer=null;
    if(key){void refresh();timer=setInterval(()=>void refresh(),15000)}
  }
  function modal(title,content,submit){
    const d=document.createElement('dialog');d.className='team-discussion-dialog';d.innerHTML=`<form class="team-form"><button type="button" class="team-discussion-close" aria-label="关闭">×</button><p class="store-eyebrow">CentaurAI-WanX Studio</p><h2>${esc(title)}</h2>${content}<p class="team-form-error" role="alert"></p><button class="button primary" type="submit">确认</button></form>`;
    d.querySelector('.team-discussion-close').onclick=()=>d.close();
    d.addEventListener('close',()=>d.remove());
    d.querySelector('form').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget;const button=form.querySelector('[type=submit]');button.disabled=true;try{await submit(new FormData(form),d);d.close();await refresh()}catch(e){d.querySelector('.team-form-error').textContent=message(e)}finally{button.disabled=false}};
    document.body.append(d);d.showModal();return d;
  }
  function login(join=false){
    const d=modal(join?'接受邀请，加入团队':'登录团队服务器',`<p>使用这台盒子已有的团队账号。每位成员独立登录，权限由服务器核验。</p><label>服务器地址<input name="serverURL" type="url" placeholder="https://wanx.example.com；本机可用 http://127.0.0.1:8089" required></label>${join?'<label>邀请码<input name="code" autocomplete="off" required></label>':''}<label>账号<input name="username" autocomplete="username" required maxlength="64"></label><label>密码<input name="password" type="password" autocomplete="${join?'new-password':'current-password'}" required maxlength="200"></label>`,async data=>{await call(join?'join':'login',Object.fromEntries(data))});
    d.querySelector('[type=submit]').textContent=join?'接受邀请并加入':'登录';
  }
  function appCards(){
    if(!key)return '<div class="empty-state"><h3>请先连接团队盒子</h3><p>公司应用由所连接盒子的管理员上架。</p><button class="button primary" data-team-action="login">登录团队服务器</button></div>';
    const available=catalog.filter(a=>a.enabled!==false);
    const content=available.length?`<div class="application-list">${available.map(a=>`<article class="application-card"><div class="application-icon" aria-hidden="true">▦</div><div class="application-copy"><h3>${esc(a.name)}</h3><p>团队内部应用${a.installed?.version?' · v'+esc(a.installed.version):''}</p></div><div class="application-actions"><button class="button small" data-team-action="open" data-project="${esc(a.id)}" data-hash="${esc(a.installed.artifactHash)}">打开</button></div><div class="application-card-footer"><span>使用团队共享业务数据</span></div></article>`).join('')}</div>`:loading?'<div class="empty-state" role="status"><h3>正在读取公司应用…</h3><p>正在核验当前账号与盒子的应用授权。</p></div>':error?'':'<div class="empty-state"><h3>暂无获准的公司应用</h3><p>管理员上架应用并授权后，即可在这里直接使用。</p></div>';
    return `<section class="content-section company-applications" aria-label="公司应用" aria-busy="${loading}"><div class="section-heading"><div><h3>公司应用 ${!loading||available.length?`<span class="count">${available.length}</span>`:''}</h3><p>由管理员验收并上架，获准成员可在当前盒子直接使用。</p></div><div class="company-applications-actions"><button class="button small" data-team-action="refresh" ${loading?'disabled':''}>${loading?'正在刷新…':'刷新公司应用'}</button>${identity?.role==='admin'?'<button class="button small" data-team-action="manage">管理上架</button>':''}</div></div>${error?`<div class="notice error" role="alert">${esc(error)}</div>`:''}${content}</section>`;
  }
  function page(){
    if(identity?.role!=='admin')return '<div class="empty-state"><h3>仅管理员可管理团队</h3><p>请使用管理员账号登录这台盒子。</p></div>';
    const adopted=projects.filter(p=>p.versioning?.adoptedHash&&!p.deletedAt);
    return `<div class="store-heading"><div><p class="store-eyebrow">${esc(identity.displayName)} · 管理员</p><h2>团队管理</h2></div><div class="store-toolbar"><button class="button" data-team-action="refresh">刷新</button><button class="button primary" data-team-action="invite">创建邀请</button></div></div>${error?`<div class="notice">${esc(error)}</div>`:''}<section class="team-real-section"><h3>团队成员 <span class="count">${members.length}</span></h3><p class="muted">使用盒子已有用户与角色。停用立即阻止该成员访问，保留其个人数据。</p><div class="team-table-scroll"><table class="team-table"><thead><tr><th>成员</th><th>账号</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>${members.map(m=>`<tr><td>${esc(m.display_name||m.username)}</td><td>${esc(m.username)}</td><td>${m.role==='admin'?'管理员':'普通用户'}</td><td>${m.disabled?'已停用':'正常'}</td><td>${m.id!==identity.id?`<button class="text-button" data-team-action="member" data-id="${m.id}" data-disabled="${!m.disabled}">${m.disabled?'恢复':'停用'}</button>`:'当前账号'}</td></tr>`).join('')}</tbody></table></div></section><section class="team-real-section"><h3>内部应用</h3><p class="muted">仅上架已确认采用的构建版本。公司应用数据与管理员的试用数据分别保存。</p>${catalog.map(a=>`<div class="team-publish-row"><div><strong>${esc(a.name)}</strong><small>${a.enabled?'已上架':'已下架'} · ${a.audience==='all'?'全部成员':'指定成员'}</small></div>${a.enabled?`<button class="button small" data-team-action="unpublish" data-app="${esc(a.appId)}">下架</button>`:''}</div>`).join('')||'<p class="muted">尚未上架应用。</p>'}</section><section class="team-real-section"><h3>已验收的构建成果</h3>${adopted.map(p=>`<div class="team-publish-row"><div><strong>${esc(p.name)}</strong><small>已采用版本 · ${esc(p.artifacts.find(a=>a.hash===p.versioning.adoptedHash)?.version||'')}</small></div><button class="button small" data-team-action="publish" data-project="${esc(p.id)}" data-hash="${esc(p.versioning.adoptedHash)}">内部上架</button></div>`).join('')||'<p class="muted">在“构建”中完成验收并确认采用后，产品会出现在这里。</p>'}</section><section class="team-real-section"><h3>邀请记录</h3><p class="muted">成员使用服务器地址和邀请码加入，随后用自己的账号登录。</p>${invites.map(i=>`<div class="team-publish-row"><div><strong>${esc(i.note||'团队成员邀请')}</strong><small>邀请码：${esc(i.code)} · ${esc(i.status||'')}</small></div>${i.status==='active'||i.status==='pending'?`<button class="button small" data-team-action="invite-revoke" data-id="${i.id}">撤销</button>`:''}</div>`).join('')||'<p class="muted">暂无邀请。</p>'}</section>`;
  }
  async function action(name,data){
    if(name==='login'){login();return}if(name==='join'){login(true);return}
    if(name==='manage'){management=true;await refresh();return 'manage'}
    if(name==='refresh'){await refresh();return}
    if(name==='invite'){const result=await call('invite.create',{note:'团队成员邀请'});modal('邀请已创建',`<p>把服务器地址和以下邀请码交给成员。成员在客户端选择“接受邀请”。</p><label>邀请码<input readonly value="${esc(result.code)}"></label>`,async()=>{});await refresh();return}
    if(name==='publish'){
      const p=projects.find(p=>p.id===data.project);if(!p)return;
      modal('上架 '+p.name,`<p>发布当前已采用版本。成员运行的是此版本，无法查看构建需求和私人资料。</p><label>可使用范围<select name="audience"><option value="all">全部成员（含后续加入的成员）</option><option value="selected">指定成员</option></select></label><fieldset class="team-member-checks"><legend>指定成员</legend>${members.filter(m=>!m.disabled).map(m=>`<label><input type="checkbox" name="members" value="${m.id}"> ${esc(m.display_name||m.username)}</label>`).join('')}</fieldset>`,async form=>{await call('publish',{projectId:data.project,artifactHash:data.hash,audience:form.get('audience'),members:form.getAll('members').map(Number)})});return;
    }
    if(name==='member'){const member=members.find(m=>m.id===Number(data.id));modal(data.disabled==='true'?'停用成员':'恢复成员',`<p>${esc(member?.display_name||member?.username)}，个人数据将保留。</p>`,async()=>call('member.update',{id:Number(data.id),disabled:data.disabled==='true'}));return}
    if(name==='unpublish'){modal('下架公司应用','<p>成员将无法继续打开或使用此应用，已有业务数据会保留。</p>',async()=>call('unpublish',{applicationId:data.app}));return}
    if(name==='invite-revoke'){await call('invite.revoke',{id:Number(data.id)});await refresh();return}
    if(name==='open'){await call('open',{projectId:data.project,artifactHash:data.hash});return}
  }
  return {sync,refresh,snapshot:()=>({identity,error,loading}),page,catalog:appCards,action,login,message};
};
