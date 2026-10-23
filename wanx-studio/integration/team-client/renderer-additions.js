// Discussion-only UI roles. Server authorization continues to use the signed-in WANX account.
app.addEventListener('change', event => {
  if (!event.target.matches('[data-team-role]')) return;
  teamUIRole = event.target.value === 'user' ? 'user' : 'admin';
  sessionStorage.setItem('wanx.team.ui-role', teamUIRole);
  profileMenuOpen = false;
  render(currentState);
  app.querySelector('[data-team-role]')?.focus();
});
function showTeamDiscussion() {
  const dialog = document.createElement('dialog');
  dialog.className = 'team-discussion-dialog';
  dialog.setAttribute('aria-labelledby', 'team-discussion-title');
  dialog.innerHTML = `<form method="dialog"><button class="team-discussion-close" aria-label="关闭">×</button></form><p class="store-eyebrow">wanx studio · 团队管理</p><h2 id="team-discussion-title">团队能力，共同构建</h2><p>当前客户端已接入原有账号、盒子、应用、空间与 Builder。右上角的角色选择用于内部讨论界面，实际访问权限仍由当前账号和盒子控制。</p><div class="team-capability-grid"><section><h3>成员与权限</h3><p>管理员邀请成员，统一管理使用范围；成员默认使用获准应用。</p><small>团队服务待接入</small></section><section><h3>公司应用</h3><p>管理员验收后明确上架，员工从公司目录直接打开应用。</p><small>内部上架待接入</small></section><section><h3>公司空间</h3><p>公司资料按授权共享，个人对话与草稿保留独立边界。</p><small>团队共享策略待接入</small></section><section><h3>运行与资源</h3><p>当前可使用原有盒子状态、模型、空间和积分入口。</p><small>使用真实 WANX 服务</small></section></div><div class="team-discussion-actions"><button class="button" data-team-jump="space">打开空间</button><button class="button" data-team-jump="boxes">查看盒子</button><button class="button primary" data-team-jump="construction">进入构建</button></div>`;
  dialog.addEventListener('click', event => {
    const button=event.target.closest('[data-team-jump]');
    if (!button) return;
    page=button.dataset.teamJump;
    dialog.close();
    render(currentState);
  });
  dialog.addEventListener('close', () => {dialog.remove();app.querySelector('[data-action="profile-menu"]')?.focus();});
  document.body.append(dialog);
  dialog.showModal();
}
