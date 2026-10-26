const labels = { team: '云账号与团队', overview: '概览', identity: '本地身份', 'first-root': '首次绑定', join: '申请新设备', approval: '核对与批准', devices: '设备清单', security: '安全管理', enrollment: '管理设备与成员', recovery: '身份恢复', backup: '业务备份与还原', transfer: '擦除后转移' };
const backupProfileLabels = { 'semantica-private-v1': '个人知识空间', 'wanx-personal-v1': '个人文件空间与便签' };
const resourceLabels = { clipboard: '个人剪贴板', semantica: '个人知识空间', 'space:personal': '个人文件空间', wanx: '个人应用与对话' };
const capabilityLabels = {
  'backup.create': '创建加密备份', 'backup.restore': '恢复业务数据', 'device.approve_manage': '添加管理设备',
  'device.approve_use': '批准使用设备', 'device.review_descendants': '重新核验受影响设备', 'device.revoke': '撤销本身份的设备',
  'member.invite': '邀请独立成员', 'member.revoke': '撤销成员资格', 'ownership.transfer': '擦除后转移盒子', 'recovery.configure': '配置与轮换恢复材料',
};
const actionLabels = { 'team.resource-set': '配置共享资源成员权限', 'team.device-resources': '确认本机共享资源范围', 'team.activate': '启用云身份团队', 'team.member-link': '关联云身份', 'team.invite-create': '创建团队邀请', 'team.invite-revoke': '撤销团队邀请', 'team.member-admit': '批准团队成员与本机设备', 'team.member-role': '修改团队权限', 'team.member-suspend': '暂停团队成员', 'team.member-revoke': '撤销团队成员', 'owner-policy.activate-v2': '启用扩展安全管理', 'device.revoke': '撤销设备',
  'device.review-descendants': '重新核验受影响设备', 'principal.revoke': '撤销成员资格',
  'device.add-manager': '添加管理设备', 'principal.invite': '邀请独立成员',
  'recovery.setup': '配置身份恢复', 'recovery.rotate': '轮换恢复材料', 'recovery.recover': '恢复本地身份',
  'backup.create': '创建加密业务备份', 'backup.restore': '还原业务数据', 'ownership.transfer-prepare': '冻结并擦除后转移盒子' };
const ownerOnlyCapabilities = new Set(['member.invite', 'member.revoke', 'ownership.transfer']);
const roles = { root: '首台管理设备', manager: '管理设备', manage: '管理设备', use: '使用设备' };
const states = { awaiting_actor_commit: '本机已确认，等待管理设备提交', pending: '等待管理设备批准', approved: '已批准', committed: '已提交', outcome_unknown: '提交结果待核实', prepared: '已准备，尚未提交', cancelled: '已取消', canceled: '已取消', expired: '已过期', rejected: '已拒绝', active: '有效', suspended: '已暂停', revoked: '已撤销' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const id = value => `<code>${escape(value || '—')}</code>`;
const date = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000
  ? `${new Date(value * 1000).toISOString().replace('T', ' ').replace('.000Z', '')} UTC` : '未设置到期时间';
const profileOpen = state => Boolean(state?.profile && !state.error && state.profile.locked === false);
function grantsView(grants) {
  if (!Array.isArray(grants) || !grants.length) return '<p class="muted">没有可授予的资源权限。</p>';
  return `<ul class="grants">${grants.map(grant => `<li><code>${escape(grant.resourceId)}</code><span>${(grant.actions || []).map(action => escape(({ read: '读取', write: '写入', execute: '执行' })[action] || action)).join('、')}</span></li>`).join('')}</ul>`;
}
function facts(rows) { return `<dl class="facts">${rows.map(([label, value]) => `<dt>${escape(label)}</dt><dd>${value}</dd>`).join('')}</dl>`; }
function operationHistory(state) {
  if (!state.securityOperations?.length) return '';
  return `<section class="card"><h2>本机安全操作记录</h2><p>记录保存在加密的本地身份中。提交结果不确定时，请核实同一操作；历史成功不代表设备现在仍有效。</p>${state.securityOperations.map(operation =>
    `<article class="request"><div><strong>${escape(actionLabels[operation.action] || operation.action)}</strong><p>${id(operation.boxId)} · ${escape(states[operation.state] || operation.state)}</p></div><button data-action="${operation.role === 'target' ? 'resume-target-approval' : 'refresh-security-operation'}" data-box-id="${escape(operation.boxId)}" data-request-id="${escape(operation.requestId)}">核实此操作</button></article>`).join('')}</section>`;
}
function passwordField(label = '独立本地口令', create = false) {
  return `<label>${label}<input name="passphrase" type="password" autocomplete="${create ? 'new-password' : 'current-password'}" required ${create ? 'minlength="12"' : ''} maxlength="1024" spellcheck="false" /></label>`;
}
function boxSelect(model) {
  const boxes = model.snapshot?.boxes || [];
  return `<label>选择已绑定的盒子<select name="boxId" required><option value="">请选择盒子</option>${boxes.map(box => `<option value="${escape(box.boxId)}" ${model.boxId === box.boxId ? 'selected' : ''}>${escape(box.boxId)} · ${escape(roles[box.role] || box.role || '已绑定')}</option>`).join('')}</select></label>`;
}
const capabilitiesView = values => Array.isArray(values) && values.length
  ? `<ul>${values.map(value => `<li>${escape(capabilityLabels[value] || value)}</li>`).join('')}</ul>` : '<p class="muted">无管理能力。</p>';
function transferScopeView(plan) {
  if (!plan?.scope) return '<p class="notice">尚无可核验的清除范围，不能继续。</p>';
  const scope = plan.scope;
  return `<p class="notice">这会影响所有已绑定成员，清空下列本地业务、缓存及同盒备份。新主人必须取得新的受保护交付秘密并建立新身份；不会继承私人数据。已另存到盒子外的独立备份无法撤回。</p>
    ${facts([['受影响成员数', escape(scope.affectedPrincipals)], ['受影响设备数', escape(scope.affectedBindings)], ['数据处理', '清除本地数据，不转交私人数据']])}
    <h3>将清除的业务目录</h3><ul>${scope.resourceRoots.map(value => `<li>${id(value)}</li>`).join('')}</ul>
    <details><summary>缓存、同盒备份与保留的安全记录</summary><h4>将清除</h4><ul>${scope.cacheRoots.map(value => `<li>${id(value)}</li>`).join('')}</ul>
      <h4>保留安全元数据（明确排除上方缓存路径）</h4><p>仅保留撤权历史与受保护交付状态，旧身份不再生效；其中列出的私人上传暂存和缓存仍会清除。</p><ul>${scope.preservedSecurityRoots.map(value => `<li>${id(value)}</li>`).join('')}</ul>
      ${facts([['清除范围摘要', id(plan.scopeManifestDigest)], ['OS 计划摘要', id(plan.resetPlanDigest)]])}</details>
    <p>确认后盒子冻结，数据连接与新授权停止；擦除或交付失败时保持冻结，不会自动恢复访问。文件删除不等于介质取证级擦除。</p>`;
}
function ledgerReviewView(review, model) {
  const effect = review.effects, emergency = review.args.mode === 'emergency-lock';
  const enrolling = ['device.add-manager', 'principal.invite'].includes(review.action) || review.targetRequiresHandoff;
  const target = review.args.target || review.args.request?.target;
  return `<section class="card review"><div class="eyebrow">提交前核对</div><h2>${escape(actionLabels[review.action] || review.action)}</h2>
    ${review.kind === 'ledger-target' ? '<p>请核对可信渠道提供的盒子指纹。这次仅用本机的两把密钥确认下列最终权限；盒子仍需原管理设备提交批准。</p>' : ''}
    ${review.action === 'principal.invite' ? '<p>邀请将建立独立成员及新的私人空间，不包含邀请人的私人文件、对话或知识。</p>' : ''}
    ${review.action === 'recovery.recover' ? '<p class="notice">此操作撤销本身份的所有旧设备，并轮换独立恢复材料。它恢复本地身份管理资格，不表示业务数据已从备份恢复；其他成员的私人数据不会交给此身份。</p>' : ''}
    ${review.action === 'owner-policy.activate-v2' ? '<p class="notice">这是当前所有权版本的一次性启用。未选择的管理能力不能通过重复启用补加；此操作不扩大文件或应用的数据权限。</p>' : ''}
    ${review.action === 'backup.create' ? `<p class="notice">本次仅备份所列私人业务范围，默认保存在同一盒子。盒子故障会同时影响这份备份；完成后需另存到独立位置并验证还原。批准任务不代表备份已生成。</p>${facts([['备份范围', escape(backupProfileLabels[review.args.scopeProfile] || review.args.scopeProfile)], ['资源', escape(review.args.resourceIds.join('、'))], ['目标', id(review.args.targetId)], ['恢复材料版本', escape(review.args.expectedRecoveryVersion)], ['加密接收密钥指纹', id(review.args.recipientKeyThumbprint)], ['包含业务集成秘密', review.args.includeBusinessSecrets ? '是；仍排除主机身份、恢复私钥及授权状态' : '否；不会自动识别文档正文中手工输入的秘密']])}` : ''}
    ${review.action === 'backup.create' && review.args.scopeProfile === 'wanx-personal-v1' ? '<p>仅包含当前身份的个人文件空间与便签，不包含对话、Agent、主用户库、设备授权、连接配置或外部存储。目标还原空间必须为空，不导出业务集成秘密。</p>' : ''}
    ${review.action === 'backup.restore' ? `<p class="notice">当前私人业务还原要求目标空间为空；已有数据时将停止并保留原数据。请先另存目标数据并核对所选身份。此操作不会恢复旧设备、撤销记录或所有权，也不会自动启用旧集成。源材料不能取得目标盒子的管理资格。</p>${review.backupSource ? facts([['来源盒子', id(review.backupSource.source.boxId)], ['来源地址', id(review.backupSource.source.baseUrl)], ['目标盒子', id(review.backupSource.target.boxId)], ['目标地址', id(review.backupSource.target.baseUrl)], ['备份创建时间', escape(date(review.backupSource.createdAt))], ['加密备份大小', `${(review.backupSource.archiveBytes / 1048576).toFixed(2)} MiB`]]) : ''}${facts([['源盒子指纹', id(review.args.sourceBoxKeyThumbprint)], ['目标描述摘要', id(review.args.targetDescriptorDigest)], ['备份编号', id(review.args.backupId)], ['密文摘要', id(review.args.archiveSha256)], ['清单摘要', id(review.args.manifestSha256)], ['范围', id(review.args.scopeProfile)]])}${review.args.ownerMapping.map(mapping => facts([['源本地成员', id(mapping.sourcePrincipalId)], ['目标本地成员', id(mapping.targetPrincipalId)], ['还原资源', escape(mapping.resourceIds.join('、'))]])).join('')}` : ''}
    ${review.action === 'ownership.transfer-prepare' ? transferScopeView(review.transferPlan) : ''}
    ${emergency ? '<p class="notice">紧急锁定可能撤销最后一条管理路径。没有已配置且可用的独立恢复材料时，将无法从云账号重新取得管理权。</p>' : ''}
    ${facts([['盒子', id(review.boxId)], ['盒子签名指纹', id(review.boxKeyThumbprint)], ['操作身份', id(review.principalId)],
      ['操作摘要', id(review.mutationDigest)], ['所有权版本', escape(review.ownershipEpoch)], ['安全清单版本', escape(review.rosterVersion)], ['核对截止', escape(date(review.expiresAt))],
      ['目标成员', id(effect.targetPrincipalId)], ['撤销设备数', escape(effect.revokedBindings.count)], ['连带暂停设备数', escape(effect.suspendedBindings.count)],
      ['失效申请数', escape(effect.invalidatedRequests.count)], ['操作后独立管理路径', escape(effect.remainingIndependentManagers)], ['已验证恢复路径', effect.verifiedRecoveryAvailable ? '存在' : '不存在']])}
    ${effect.redacted ? '<p>仅显示成员资格变更与影响数量；不读取该成员的私人设备、密钥或文件。</p>' : ''}
    ${effect.targetSummaries.map(target => `<article class="device">${facts([['目标设备', id(target.clientId)], ['绑定', id(target.bindingId)], ['角色', escape(roles[target.role])], ['访问指纹', id(target.accessKeyThumbprint)], ['批准指纹', id(target.approvalKeyThumbprint)]])}</article>`).join('')}
    ${target ? `<h3>新管理设备及最终权限</h3>${facts([['设备编号', id(target.clientId)], ['访问指纹', id(review.targetAccessKeyThumbprint)], ['批准指纹', id(review.targetApprovalKeyThumbprint)], ['到期时间', escape(date(target.expiresAt ?? effect.resultingAuthority?.expiresAt))], ['转授权到期', escape(date(target.delegationExpiresAt ?? effect.resultingAuthority?.delegationExpiresAt))]])}${capabilitiesView(target.capabilities || effect.resultingAuthority?.capabilities)}${grantsView(target.grants || effect.resultingAuthority?.grants)}<h4>可向后续设备授予的权限</h4>${grantsView(target.delegableGrants || effect.resultingAuthority?.delegableGrants)}` : ''}
    ${review.action === 'team.device-resources' ? `<h3>目标设备最终数据范围</h3>${facts([['目标绑定', id(review.args.bindingId)], ['目标成员', id(review.args.principalId)], ['绑定版本', escape(review.args.expectedBindingRevision)], ['访问指纹', id(review.targetAccessKeyThumbprint)], ['批准指纹', id(review.targetApprovalKeyThumbprint)]])}${grantsView(review.args.grants)}<p>提交后旧数据连接会关闭，目标设备需重新连接。</p>` : ''}
    ${effect.recoveryAfter ? `<h3>恢复材料变更</h3>${facts([['原材料版本', escape(effect.recoveryVersionBefore)], ['新材料版本', escape(effect.recoveryVersionAfter)], ['新材料编号', id(effect.recoveryAfter.recoveryId)], ['恢复有效期', escape(date(effect.recoveryAfter.expiresAt))]])}<h4>恢复材料所能恢复的管理能力</h4>${capabilitiesView(effect.recoveryAfter.capabilities)}${grantsView(effect.recoveryAfter.grants)}<p>旧材料立即失去在线恢复资格；持有旧材料的人仍可能解密已经复制的旧备份。</p>` : ''}
    ${effect.capabilitiesBefore !== null ? `<h3>原管理能力</h3>${capabilitiesView(effect.capabilitiesBefore)}<h3>变更后管理能力</h3>${capabilitiesView(effect.capabilitiesAfter)}` : ''}
    ${effect.grantsBefore !== null ? `<h3>原数据范围</h3>${grantsView(effect.grantsBefore)}<h3>变更后数据范围</h3>${grantsView(effect.grantsAfter)}` : ''}
    ${review.action === 'team.member-admit' ? '<p class="notice">申请设备需先刷新申请并用本地双钥确认此最终清单。对方确认后，再在这里输入本地口令提交。云登录与邀请码均不会直接授权。</p>' : ''}
    ${enrolling && review.kind !== 'ledger-target' ? `<h3>对方设备确认</h3><button data-action="export-target-review">生成给对方核对的最终清单</button>${model.reviewHandoff ? `<label>最终清单<textarea readonly rows="5">${escape(model.reviewHandoff)}</textarea></label>` : ''}<form data-form="importTargetProofs"><label>对方确认后返回的文本<textarea name="targetProofs" rows="5" maxlength="65536" required></textarea></label><button type="submit">核验双方密钥确认</button></form><p>${review.targetConfirmed ? '已核验对方两把密钥对同一最终清单的确认。' : '等待对方设备确认，当前不能提交。'}</p>` : ''}
    <form data-form="confirm-review">${review.action === 'ownership.transfer-prepare' ? '<label>输入“清除本地数据”以确认所有成员的数据影响<input name="eraseConfirmation" autocomplete="off" required pattern="清除本地数据" /></label>' : ''}${passwordField('再次输入本地口令以确认此次操作')}<label class="check"><input type="checkbox" name="reviewed" required />我已核对目标、权限变化、连带影响及剩余恢复路径</label>
    <div class="actions"><button class="primary" type="submit" ${enrolling && review.kind !== 'ledger-target' && !review.targetConfirmed ? 'disabled' : ''}>${review.kind === 'ledger-target' ? '确认本机密钥及权限' : emergency ? '确认紧急锁定' : '确认提交此操作'}</button><button type="button" data-action="lock">取消并锁定</button></div></form></section>`;
}
function enrollmentView(model) {
  const member = model.enrollmentKind === 'prepareMemberInvitation';
  return `<section class="card"><h2>在新设备上准备</h2><p>本机的公钥和设备编号可交给已有管理设备。私人密钥不会导出。</p><button data-action="export-target-info">生成本机公开材料</button>
    ${model.targetInfo ? `<label>本机公开材料<textarea readonly rows="5">${escape(model.targetInfo.targetInfo)}</textarea></label>${facts([['访问指纹', id(model.targetInfo.accessKeyThumbprint)], ['批准指纹', id(model.targetInfo.approvalKeyThumbprint)]])}` : ''}
    <form data-form="prepareTargetApproval"><label>管理设备提供的最终核对清单<textarea name="reviewHandoff" rows="5" maxlength="65536" required></textarea></label><button type="submit">核对盒子与本机权限</button></form></section>
    <section class="card"><h2>在已有管理设备上批准</h2><form data-form="refreshSecurityState">${boxSelect(model)}<button type="submit">读取当前管理权限</button></form>
    ${model.security ? `<form data-form="prepare-enrollment"><label>操作类型<select name="operation"><option value="prepareManagerEnrollment" ${!member ? 'selected' : ''}>添加同一身份的管理设备</option><option value="prepareMemberInvitation" ${member ? 'selected' : ''}>邀请独立成员</option></select></label>
      <label>新设备提供的公开材料<textarea name="targetInfo" rows="5" maxlength="65536" required></textarea></label><h3>明确选择管理能力</h3>
      ${model.security.capabilities.filter(value => !member || !ownerOnlyCapabilities.has(value)).map(value => `<label class="check"><input type="checkbox" name="cap:${escape(value)}" />${escape(capabilityLabels[value])}</label>`).join('')}
      <h3>数据范围</h3><p>独立成员得到自己的新空间；这些选项不会转交邀请人的私人数据。</p>
      ${Object.entries(resourceLabels).map(([resource, label]) => `<fieldset><legend>${escape(label)}</legend>${['read', 'write', 'execute'].map(action => `<label class="check"><input type="checkbox" name="grant:${escape(resource)}:${action}" />${escape(({ read: '读取', write: '写入', execute: '执行' })[action])}<input type="checkbox" name="delegate:${escape(resource)}:${action}" />允许向后续设备授予此项</label>`).join('')}</fieldset>`).join('')}
      <label>设备到期时间（空白表示请求不限期）<input type="datetime-local" name="expiresAt" /></label><label>转授权到期时间<input type="datetime-local" name="delegationExpiresAt" /></label><p class="hint">盒子会核对当前有效权限和期限；请求不能扩大已有授权。</p><button class="primary" type="submit">准备最终权限清单</button></form>` : ''}</section>`;
}
function recoveryView(model) {
  const draft = model.material, imported = model.recoveryImport;
  return `<section class="card"><h2>独立身份恢复</h2><p>恢复依赖单独保存的离线材料，不能通过云账号、短信、登录密码或恢复出厂设置取回。离线材料同时可以解密相应历史备份，请单独保管。</p>
    <form data-form="beginRecoveryConfiguration">${boxSelect(model)}<button type="submit">配置或轮换恢复材料</button></form>
    <h3>在全新的本地身份上恢复</h3><button data-action="import-identity-recovery">选择已保存的恢复材料</button>
    ${imported ? `${facts([['材料对应盒子', id(imported.descriptor.boxId)], ['盒子指纹', id(imported.boxKeyThumbprint)], ['本地身份', id(imported.principalId)], ['当前恢复版本', escape(imported.newRecovery.version)]])}<button data-action="begin-identity-recovery">生成下一代恢复材料并继续</button>` : ''}
    ${draft ? `<h3>${draft.operation === 'recovery.recover' ? '恢复身份前保存新的材料' : '保存并验证独立恢复材料'}</h3>${facts([['材料版本', escape(draft.newRecovery.version)], ['材料编号', id(draft.newRecovery.recoveryId)], ['签名指纹', id(draft.signingKeyThumbprint)], ['当前步骤', escape(({ draft_generated: '尚未保存', exported: '已保存，等待实际重新导入', reimport_verified: '文件和两把密钥均已验证，尚未提交' })[draft.state] || draft.state)]])}
      <p>保存成功后程序释放生成时的私钥。必须从原生文件选择器重新打开所保存的文件，才能继续。</p>
      ${draft.state === 'draft_generated' ? '<button data-action="export-recovery-material">选择位置并保存离线材料</button>' : '<button data-action="reimport-recovery-material">重新选择已保存的材料文件</button>'}
      ${draft.state === 'reimport_verified' ? '<button class="primary" data-action="prepare-recovery">核对恢复权限与影响</button>' : ''}` : ''}</section>`;
}
function backupView(model) {
  const source = model.backupSource;
  return `<section class="card"><h2>加密业务备份</h2><p>请选择盒子当前支持的一种私人业务范围；不包含整个盒子、其他成员私域或本地身份密钥。需要先配置并实际保存独立恢复材料。</p>
    <form data-form="refreshBackupTargets">${boxSelect(model)}<button type="submit">读取可用备份目标</button></form>
    ${model.backupTargets ? `<p>${model.backupTargets.recovery ? '当前身份已有恢复配置。' : '尚无有效恢复配置，请先配置并验证恢复材料。'}</p>${model.backupTargets.targets.map(target => `<form data-form="prepareBackupCreate"><input type="hidden" name="targetId" value="${escape(target.targetId)}" /><h3>盒子内的加密存储</h3><p>同盒存储；最多 ${Math.floor(target.maxArchiveBytes / 1048576)} MiB。</p><label>明确选择备份范围<select name="scopeProfile" required>${target.scopeProfiles.length > 1 ? '<option value="">请选择一种范围</option>' : ''}${target.scopeProfiles.map(profile => `<option value="${escape(profile)}" ${model.backupProfile === profile ? 'selected' : ''}>${escape(backupProfileLabels[profile])}</option>`).join('')}</select></label>${target.scopeProfiles.includes('wanx-personal-v1') ? '<p>个人文件空间与便签不包括对话、Agent、授权或外部存储。</p>' : ''}<label class="check"><input type="checkbox" name="includeBusinessSecrets" ${model.backupProfile === 'semantica-private-v1' ? '' : 'disabled'} />明确包含受支持的业务集成秘密（恢复后仍需重新启用）</label><button type="submit" ${!model.backupTargets.recovery ? 'disabled' : ''}>核对并批准备份任务</button></form>`).join('')}` : ''}</section>
    <section class="card"><h2>从加密备份还原业务数据</h2><p>先在目标盒子完成独立绑定及恢复配置。随后分别选择源恢复材料和加密备份，系统验证来源、摘要与成员对应关系。文件路径和恢复私钥不会交给页面。</p>
    <form data-form="importBackupSource">${boxSelect(model)}<button type="submit">选择源恢复材料与备份文件</button></form>
    ${source ? `${facts([['已检查文件', escape(source.label)], ['源盒子', id(source.sourceBoxId)], ['源盒子指纹', id(source.sourceBoxKeyThumbprint)], ['源成员', id(source.sourcePrincipalId)], ['目标成员', id(source.targetPrincipalId)], ['密文摘要', id(source.archiveSha256)], ['范围', id(source.scopeProfile)]])}<button data-action="prepare-backup-restore">核对目标还原范围</button>` : ''}</section>`;
}
function backupResultView(result) {
  const status = result.status, completed = status.state === 'completed';
  const created = completed && status.result?.type === 'backup-created', restored = completed && status.result?.type === 'data-restore-completed';
  return `<section class="card" role="status"><h2>${created ? '盒子已生成加密备份' : restored ? '业务数据还原已验证完成' : '业务任务状态'}</h2>
    ${facts([['操作', id(status.operationId)], ['状态', escape(({ queued: '排队等待', running: '执行中', completed: '完成', failed: '失败', cancelled: '取消' })[status.state])], ['阶段', id(status.phase)], ['错误码', id(status.errorCode)]])}
    ${status.recoveryRequired ? '<p class="notice">还原中断后尚未完成核验，数据入口继续隔离。请按同一操作的恢复诊断处理，不要强行启动旧程序。</p>' : ''}
    ${created ? `<p>备份已持久保存在同一盒子；这还不是独立位置的副本。</p>${facts([['备份编号', id(status.result.backupId)], ['密文摘要', id(status.result.archiveSha256)]])}<button data-action="save-backup-archive" data-box-id="${escape(result.boxId)}" data-request-id="${escape(result.requestId)}">另存到此设备选择的位置</button>` : ''}
    ${restored ? '<p>已核验目标业务数据；安全授权状态保持独立，历史设备不会重新获得访问权限，旧集成没有自动启用。</p>' : ''}
    ${result.localCopy ? `<p>已实际另存并校验完整摘要：${escape(result.localCopy.label)}。请另行进行还原演练。</p>` : ''}
    ${status.phase === 'awaiting_key' ? `<p>任务等待这份备份的解密密钥。请选择源恢复材料；只向已批准的目标交付本份备份的数据密钥。</p><button data-action="provide-restore-key" data-box-id="${escape(result.boxId)}" data-request-id="${escape(result.requestId)}">导入材料并提供单份备份密钥</button>` : ''}
    ${result.keyReceived ? '<p>目标已确认收到本份备份的数据密钥；业务数据还原仍需等待最终核验。</p>' : ''}
    <button data-action="refresh-backup-operation" data-box-id="${escape(result.boxId)}" data-request-id="${escape(result.requestId)}">核实任务进度</button></section>`;
}
function securityView(model) {
  const current = model.security;
  return `<section class="card"><h2>本地安全管理</h2><p>从盒子读取本身份的当前授权。云账号登录和历史成功回执不能替代当前权限。</p>
    <form data-form="refreshSecurityState">${boxSelect(model)}<button class="primary" type="submit">读取当前安全状态</button></form>
    ${current ? `<h3>${escape(current.boxId)}</h3>${facts([['当前身份', id(current.self.principalId)], ['当前设备', id(current.self.bindingId)], ['当前访问状态', current.self.active ? '有效' : '不可用'], ['独立恢复材料', current.recovery ? '已配置' : '未配置']])}
      <h3>此设备的管理能力</h3>${capabilitiesView(current.capabilities)}
      ${current.qualifiedOriginalOwnerRoot ? `<form data-form="prepareActivatePolicy"><h3>启用扩展安全管理</h3><p>只有原始首台管理设备可以执行一次。逐项选择需要的能力；未选能力在当前所有权版本不能再次补加。</p>${Object.entries(capabilityLabels).map(([value, label]) => `<label class="check"><input type="checkbox" name="cap:${escape(value)}" ${value === 'device.approve_use' ? 'checked disabled' : ''} />${escape(label)}</label>`).join('')}<button type="submit">核对所选管理能力</button></form>` : ''}
      <h3>本身份的设备</h3><div class="device-list">${current.devices.map(device => `<article class="device">${facts([['设备', id(device.clientId)], ['绑定', id(device.bindingId)], ['角色', escape(roles[device.role])], ['状态', escape(states[device.status] || device.status)], ['访问指纹', id(device.accessKeyThumbprint)], ['批准指纹', id(device.approvalKeyThumbprint)]])}
        ${current.capabilities.includes('device.revoke') && device.status !== 'revoked' ? `<div class="actions"><button data-action="revoke-device" data-binding-id="${escape(device.bindingId)}">核对撤销</button><button data-action="emergency-revoke" data-binding-id="${escape(device.bindingId)}">核对紧急锁定</button></div>` : ''}
        ${current.capabilities.includes('device.review_descendants') && device.status === 'suspended' ? `<button data-action="review-descendant" data-binding-id="${escape(device.bindingId)}">重新核验授权链</button>` : ''}</article>`).join('')}</div>
      ${current.capabilities.some(value => ['member.invite', 'member.revoke'].includes(value)) ? '<button data-action="refresh-members">读取成员资格清单</button>' : ''}
      ${model.members ? `<h3>成员资格</h3><p>成员的私人设备和数据不会显示在此清单中。</p>${model.members.members.map(member => `<article class="device">${facts([['成员', id(member.principalId)], ['状态', escape(states[member.status] || member.status)]])}${current.capabilities.includes('member.revoke') && member.principalId !== current.self.principalId && member.status !== 'revoked' ? `<button data-action="revoke-member" data-principal-id="${escape(member.principalId)}">核对撤销成员资格</button>` : ''}</article>`).join('')}` : ''}` : ''}</section>`;
}
function reviewView(review, model) {
  if (review.kind === 'team-join') return `<section class="card review"><h2>核对云身份与团队设备申请</h2><p>请通过可信渠道核对盒子与本机设备指纹。提交后需管理员审核，并由本机再次确认最终权限。</p>${facts([['云身份', id(review.subject)], ['盒子', id(review.boxId)], ['盒子指纹', id(review.boxKeyThumbprint)], ['访问密钥', id(review.accessKeyThumbprint)], ['批准密钥', id(review.approvalKeyThumbprint)], ['申请角色', escape(review.roleId)]])}${grantsView(review.grants)}<form data-form="confirm-review">${passwordField()}<label class="check"><input type="checkbox" name="reviewed" required />已核对盒子、云身份和权限</label><button class="primary">发送申请</button><button type="button" data-action="lock">取消并锁定</button></form></section>`;
  if (review.kind === 'team-target') return ledgerReviewView(review, model);

  if (['ledger-mutation', 'ledger-target', 'ledger-recovery'].includes(review.kind)) return ledgerReviewView(review, model);
  const kind = review.kind;
  return `<section class="card review"><div class="eyebrow">提交前核对</div><h2>${kind === 'first-root' ? '建立首台管理设备' : kind === 'join' ? '申请此设备的使用权限' : '批准新的使用设备'}</h2>
    <p>${kind === 'approval' ? '请通过可信方式与申请设备核对指纹。只有下列设备和权限会进入批准操作。' : kind === 'first-root' ? '请核对受保护交付材料中的盒子指纹。此操作将建立本地管理关系。' : '将生成只能用于当前身份、当前盒子的使用设备申请。此设备不能批准其他设备。'}</p>
    ${facts([['盒子', id(review.boxId)], ['盒子签名指纹', id(review.boxKeyThumbprint)], ['本地身份', id(review.principalId)], ['申请设备', id(review.clientId)], ['访问密钥指纹', id(review.accessKeyThumbprint)], ['设备角色', escape(roles[review.role] || review.role)], ...(review.approverBindingId ? [['批准设备绑定', id(review.approverBindingId)]] : []), ...(review.requestDigest ? [['申请摘要', id(review.requestDigest)]] : []), ['所有权版本', escape(review.ownershipEpoch ?? '—')], ['设备清单版本', escape(review.rosterVersion ?? '—')], ['本次核对截止', escape(date(review.expiresAt))], ['设备权限有效期', escape(date(review.grantExpiresAt))]])}
    <h3>授权范围</h3>${grantsView(review.grants)}
    <form data-form="confirm-review">${kind !== 'join' ? `${passwordField('再次输入本地口令以确认此次操作')}<p class="hint">每次批准单独核验口令。口令不会提交到盒子或平台。</p>` : ''}
      <label class="check"><input type="checkbox" name="reviewed" required />我已核对盒子、设备指纹和权限范围</label>
      <div class="actions"><button class="primary" type="submit">${kind === 'join' ? '发送使用设备申请' : kind === 'first-root' ? '确认建立管理关系' : '确认批准此设备'}</button><button type="button" data-action="lock">取消核对并锁定</button></div>
    </form></section>`;
}
function transferResultView(result) {
  const status = result.transferStatus, ready = status.state === 'redelivery_ready';
  return `<section class="card" role="status"><h2>${escape(({ frozen: '所有权已冻结', erase_pending: '已进入 OS 擦除流程', redelivery_ready: '已验证擦除，新的交付材料已就绪' })[status.state])}</h2>
    <p>${ready ? '这是同一账本记录的 OS 擦除与新材料准备结果，不表示新主人已完成绑定。新主人仍须通过受保护渠道取得新的交付秘密；此页面不会提供该秘密。' : '当前盒子保持冻结，数据与授权不能恢复。尚无完整的擦除及新交付就绪证据；连接失败、重启或等待超时都不算完成。'}</p>
    ${facts([['盒子', id(result.boxId)], ['原转移编号', id(status.transferId)], ['对应事件时间', escape(date(status.updatedAt))], ['原所有权版本', escape(status.sourceOwnershipEpoch)], ['事件所有权版本', escape(status.checkpoint.context.ownershipEpoch)]])}
    <p>已另存到盒子外的独立备份无法撤回。旧账号和设备不能因查看此历史结果重新获得访问。</p>
    <details><summary>核验证据</summary>${facts([['事件摘要', id(status.checkpoint.eventDigest)], ['OS 擦除证据', id(status.resetEvidenceDigest)], ['受保护交付准备证据', id(status.preparedDeliveryDigest)]])}</details>
    <button data-action="refresh-transfer-status" data-box-id="${escape(result.boxId)}" data-request-id="${escape(result.requestId)}">核实擦除与交付状态</button></section>`;
}
function resultView(result) {
  if (!result) return '';
  if (result.teamOperation) return `<section class="card" role="status"><h2>${escape(states[result.state] || '团队关联状态')}</h2><p>${result.self?.active ? '本机当前绑定已生效，可返回主窗口连接该盒子。' : '申请和云端关联不会自动授权；请继续核实本机批准状态。'}</p>${result.deliveryStatus ? `<p>云端关联：${escape(result.deliveryStatus)}</p>` : ''}${result.requestId ? `<button data-action="team-request" data-box-id="${escape(result.boxId)}" data-request-id="${escape(result.requestId)}">核实申请与设备批准</button>` : ''}</section>`;
  if (result.transferStatus) return transferResultView(result);
  if (result.backupOperation && result.status) return backupResultView(result);
  if (result.targetProofs) return `<section class="card"><h2>本机已确认最终清单</h2><p>请把下列确认文本交回管理设备。当前尚未获得已生效的设备绑定。重新打开此记录不会生成新签名；已提交结果仍需核验盒子回执和本机当前状态。</p><textarea readonly rows="6">${escape(result.targetProofs)}</textarea><form data-form="acceptEnrollmentReceipt"><label>管理设备提交后返回的盒子回执<textarea name="receipt" rows="5" maxlength="16384" required></textarea></label><button type="submit">核验回执并读取本机当前状态</button></form></section>`;
  if (result.securityOperation) {
    const effect = result.dataEffect;
    return `<section class="card" role="status"><h2>${escape(states[result.state] || '安全操作状态')}</h2>
      <p>${result.state === 'committed' ? '盒子已记录此次安全变更。此回执是提交事实；当前设备有效性与数据连接关闭情况单独核实。' : '尚未取得确定的提交结果。请查询同一操作；不要重复生成新申请或恢复材料。'}</p>
      ${facts([['盒子', id(result.boxId)], ['操作编号', id(result.requestId)], ['本机当前状态', result.self ? (result.self.active ? '有效' : '已失效或暂停') : '尚未核实'],
        ...(effect ? [['数据连接状态', escape(({ effective: '已确认关闭', pending: '正在关闭', failed: '关闭未完成', unknown: '尚无完整关闭证据' })[effect.effectState] || '尚未核实')]] : [])])}
      ${result.recoveryOutcome ? `<p>${result.recoveryOutcome === 'identity-recovered' ? '恢复管理身份的操作已提交；业务数据恢复需要单独核验。' : '恢复配置已提交；这不表示已创建或恢复业务数据备份。'}</p>` : ''}
      ${result.ack?.action === 'team.invite-create' ? `<button data-action="team-invite-export" data-box-id="${escape(result.boxId)}" data-request-id="${escape(result.requestId)}">显示已签名团队邀请</button>` : ''}
      ${result.ack?.action === 'ownership.transfer-prepare' ? '<p class="notice">已提交冻结所有权的批准。这不表示数据已擦除，也不表示新交付秘密已准备完成。必须等待 OS 的独立擦除和交付结果；故障时盒子保持冻结。</p><button data-action="refresh-transfer-status" data-box-id="' + escape(result.boxId) + '" data-request-id="' + escape(result.requestId) + '">核实擦除与交付状态</button>' : ''}
      ${['backup.create', 'backup.restore'].includes(result.ack?.action) ? `<p>已批准业务任务；是否完成由任务的独立核验结果决定。</p><button data-action="refresh-backup-operation" data-box-id="${escape(result.boxId)}" data-request-id="${escape(result.requestId)}">查看业务任务状态</button>` : ''}
      <div class="actions"><button data-action="refresh-security-operation" data-box-id="${escape(result.boxId)}" data-request-id="${escape(result.requestId)}">核实提交结果</button>${effect ? `<button data-action="refresh-data-effect" data-box-id="${escape(result.boxId)}" data-request-id="${escape(result.requestId)}">核实数据连接关闭</button>` : ''}${['device.add-manager', 'principal.invite', 'team.device-resources'].includes(result.ack?.action) ? `<button data-action="export-security-receipt" data-box-id="${escape(result.boxId)}" data-request-id="${escape(result.requestId)}">显示交给新设备的盒子回执</button>` : ''}</div>${result.receipt ? `<textarea readonly rows="5">${escape(result.receipt)}</textarea>` : ''}</section>`;
  }
  const confirmed = Boolean(result.ack && typeof result.ack === 'object' && result.ack.bindingId && result.ack.requestId);
  return `<section class="card ${confirmed ? 'success' : ''}" role="status"><h2>${confirmed ? '盒子已确认绑定' : '申请状态'}</h2><p>${confirmed ? '已校验盒子回执，并记录本地设备绑定。' : escape(states[result.state] || '结果待确认，请刷新状态。')}</p>
    ${facts([['盒子', id(result.boxId)], ['申请编号', id(result.requestId)], ...(confirmed ? [['设备绑定', id(result.ack.bindingId)], ['设备清单版本', escape(result.ack.rosterVersion)]] : [])])}
    ${result.invitation ? `<label>交给管理设备的申请文本<textarea readonly rows="5" spellcheck="false">${escape(result.invitation)}</textarea></label><p class="hint">请通过可信渠道交给管理设备，并核对双方显示的设备指纹。不会自动复制到剪贴板。</p>` : ''}
    ${result.boxId && result.requestId ? `<div class="actions"><button data-action="refresh-request" data-box-id="${escape(result.boxId)}" data-request-id="${escape(result.requestId)}">刷新申请状态</button>${!confirmed && result.state === 'pending' ? `<button data-action="cancel-request" data-box-id="${escape(result.boxId)}" data-request-id="${escape(result.requestId)}">取消我的申请</button>` : ''}</div>` : ''}
  </section>`;
}
function teamView(model) {
  const current = model.team, cloud = model.snapshot.cloud, cloudReady = cloud?.phase === 'authenticated';
  const resourceOptions = current?.authority?.grants || [];
  return `<section class="card"><h2>云账号与团队设备</h2><p>${cloudReady ? '已登录云账号：' + escape(cloud.accountId) : '请先在主窗口完成云端注册或登录，再回到这里申请团队。'} 云端登录只证明账号身份，访问盒子仍需本机密钥与管理设备批准。</p>
    <form data-form="prepareTeamJoin"><label>管理员提供的已签名邀请<textarea name="invitation" rows="5" maxlength="65536" required></textarea></label><label>云端盒子编号<input name="deviceId" required maxlength="128" /></label><button ${!cloudReady ? 'disabled' : ''}>核对团队邀请</button></form></section>
    <section class="card"><h2>本机团队申请</h2>${(model.snapshot.teamRequests || []).map(item => `<article class="request"><span>${escape(item.boxId)} · ${escape(states[item.state])}</span><button data-action="team-request" data-box-id="${escape(item.boxId)}" data-request-id="${escape(item.requestId)}">核实申请</button></article>`).join('') || '<p>尚无申请。</p>'}</section>
    <section class="card"><h2>已批准团队与设备</h2><form data-form="refreshTeam">${boxSelect(model)}<button>读取团队权限与成员</button></form><form data-form="refreshTeamAssociation">${boxSelect(model)}<button>同步已批准的云端设备关联</button></form>
    ${current && current.manageTeam !== false ? `<h3>成员</h3>${current.members.map(member => `<article class="device">${facts([['云身份', id(member.subject)], ['角色', escape(member.roleId)], ['状态', escape(states[member.status])]])}${member.roleId !== 'owner' ? `<form data-form="prepareTeamMemberRole"><input type="hidden" name="principalId" value="${escape(member.principalId)}" /><label>团队角色<select name="roleId"><option value="member">普通成员</option><option value="manager">应用与资源管理者</option></select></label><button>核对权限变更</button></form><button data-action="team-suspend" data-principal-id="${escape(member.principalId)}">暂停访问</button><button data-action="team-revoke" data-principal-id="${escape(member.principalId)}">撤销成员</button>` : ''}</article>`).join('')}
      <h3>等待批准</h3>${current.requests.filter(item => item.state === 'pending').map(item => `<article class="request"><span>${escape(item.subject)}</span><button data-action="team-admit" data-request-id="${escape(item.requestId)}">核对身份与最终设备权限</button></article>`).join('') || '<p>暂无待批准申请。</p>'}
      <h3>创建邀请</h3><form data-form="prepareTeamInvite"><label>邀请角色<select name="roleId"><option value="member">普通成员</option><option value="manager">应用与资源管理者</option></select></label><p>邀请一天内有效。只勾选该成员需要的资源；管理者还需团队管理资源。成员可在已批准设备上使用独立批准密钥管理自己的设备；云账号密码不会取得此能力。</p><label class="check"><input type="checkbox" name="allowDeviceApproval" checked />允许成员用本机批准密钥批准自己的后续使用设备</label>${resourceOptions.map(grant => `<fieldset><legend>${escape(resourceLabels[grant.resourceId] || grant.resourceId)}</legend>${grant.actions.map(action => `<label class="check"><input type="checkbox" name="grant:${escape(grant.resourceId)}:${escape(action)}" />${escape(({read:'读取',write:'写入',execute:'执行'})[action])}</label>`).join('')}</fieldset>`).join('')}<button>核对邀请权限</button></form>
      <h3>共享知识空间</h3><button data-action="team-knowledge-create">登记新的共享知识空间</button><p>先配置资源成员权限，再对本机设备明确批准。设备范围变更后需要重新连接盒子，再在星图中创建或访问仓库。</p>${current.resources.map(resource => `<article class="device"><h4>${escape(resource.resourceId)}</h4><button data-action="team-device-resource" data-resource-id="${escape(resource.resourceId)}">核对本机对此资源的访问范围</button><form data-form="prepareTeamResourceAccess"><input type="hidden" name="resourceId" value="${escape(resource.resourceId)}" /><p>仅勾选允许访问的有效成员</p>${current.members.filter(member => member.status === 'active').map(member => `<fieldset><legend>${escape(member.subject)}</legend>${['read','write'].map(action => `<label class="check"><input type="checkbox" name="acl:${escape(member.principalId)}:${action}" ${resource.grants.some(grant => grant.principalId === member.principalId && grant.actions.includes(action)) ? 'checked' : ''} />${action === 'read' ? '读取' : '写入'}</label>`).join('')}</fieldset>`).join('')}<button>核对资源成员权限</button></form></article>`).join('')}
      <h3>邀请记录</h3>${current.invitations.map(invite => `<article class="request"><span>${escape(invite.roleId)} · ${escape(states[invite.status] || invite.status)}</span>${invite.status === 'pending' ? `<button data-action="team-invite-revoke" data-invitation-id="${escape(invite.invitationId)}">撤销邀请</button>` : ''}</article>`).join('')}` : ''}</section>
    ${current ? `<section class="card"><h2>本机可申请的团队资源</h2><p>这里只显示属于当前身份的资源权限。新增资源必须由已批准管理设备确认，已有云登录不会扩展本机权限。</p>${(current.selfResources?.availableGrants || []).map(grant => `<article class="device">${grantsView([grant])}<button data-action="team-device-resource" data-resource-id="${escape(grant.resourceId)}">用本机批准密钥核对资源</button></article>`).join('') || '<p>暂无可申请资源。</p>'}
      <form data-form="exportTeamDeviceResourceInfo">${boxSelect(model)}<button>导出本机已签名资源清单给管理员</button></form>${model.resourceInfo ? `<textarea readonly rows="5">${escape(model.resourceInfo)}</textarea><p>清单短时有效，请通过可信渠道传递并核对盒子和设备。</p>` : ''}
      <form data-form="prepareTargetApproval"><label>管理员返回的最终核对清单<textarea name="reviewHandoff" rows="5" maxlength="65536" required></textarea></label><button>核对目标设备与资源范围</button></form>
      ${current.manageTeam !== false ? `<form data-form="prepareTeamRemoteDeviceResource">${boxSelect(model)}<label>成员提供的已签名本机资源清单<textarea name="resourceInfo" rows="5" maxlength="16384" required></textarea></label><label>本次批准的资源<select name="resourceId">${current.resources.map(resource => `<option value="${escape(resource.resourceId)}">${escape(resource.resourceId)}</option>`).join('')}</select></label><button>核对成员设备资源变更</button></form>` : ''}</section>` : ''}
    ${model.teamInvitation ? `<section class="card"><h2>发送给成员的邀请</h2><p>通过可信渠道另行核对盒子指纹。邀请码不授予访问权限。</p><textarea readonly rows="7">${escape(model.teamInvitation)}</textarea></section>` : ''}
    <details class="card"><summary>现有盒子启用云身份团队</summary><p>仅已批准且具备成员邀请能力的拥有者管理设备可操作；必要时先在安全管理中启用扩展策略。</p><form data-form="prepareTeamActivation">${boxSelect(model)}<label>云端盒子编号<input name="deviceId" required maxlength="128" /></label><button ${!cloudReady ? 'disabled' : ''}>核对并启用团队云身份</button></form><form data-form="prepareTeamLink">${boxSelect(model)}<label>云端盒子编号<input name="deviceId" required maxlength="128" /></label><button ${!cloudReady ? 'disabled' : ''}>核对已批准本地身份的云关联</button></form></details>`;
}
function content(model) {
  const state = model.snapshot, profile = state?.profile;
  if (!state) return '<section class="card"><p>正在读取本地身份…</p></section>';
  if (state.error) return '<section class="card"><h2>本地身份暂时不可读取</h2><p>请保留现有身份文件，不要删除或重新建立身份。关闭窗口后检查本地存储权限，必要时联系支持人员。</p><p class="hint">当前无法确认身份状态，绑定和批准操作已暂停。</p></section>';
  if (!profile) return `<section class="card"><div class="eyebrow">从这台设备开始</div><h2>建立独立本地身份</h2><p>设置与平台登录密码不同的口令。身份和密钥保存在这台设备，不通过平台账号恢复。</p><form data-form="createProfile">${passwordField('设置本地口令（至少 12 个字符）', true)}<label>再次输入本地口令<input name="repeatPassphrase" type="password" autocomplete="new-password" required minlength="12" maxlength="1024" /></label><p class="hint">请妥善保存口令。绑定盒子后，请单独配置并验证身份恢复材料。</p><button class="primary" type="submit">建立本地身份</button></form></section>`;
  if (!profileOpen(state)) return `<section class="card"><div class="eyebrow">本地身份已锁定</div><h2>解锁这台设备</h2><p>平台登录不会解锁本地身份。关闭此窗口、锁定或系统休眠后，需要重新输入本地口令。</p><form data-form="unlock">${passwordField()}<button class="primary" type="submit">解锁本地身份</button></form></section>`;
  if (model.review) return reviewView(model.review, model);
  if (model.view === 'team') return teamView(model);
  if (model.view === 'security') return securityView(model);
  if (model.view === 'enrollment') return enrollmentView(model);
  if (model.view === 'recovery') return recoveryView(model);
  if (model.view === 'backup') return backupView(model);
  if (model.view === 'transfer') return `<section class="card"><h2>擦除后转移盒子</h2><p>此操作先冻结当前所有权，再由受保护的 OS 流程清除所有成员的本地业务数据并准备新交付材料。不会把私人数据交给新主人，也不能由云账号代替本地批准。</p><form data-form="prepareOwnershipTransfer">${boxSelect(model)}<button type="submit">读取盒子签名的实际清除范围</button></form></section>`;
  if (model.view === 'identity') return `<section class="card"><h2>当前本地身份</h2>${facts([['本地身份编号', id(profile.principalId)], ['本机设备编号', id(profile.clientId)], ['密钥保护', '软件口令保护'], ['恢复机制', '按盒子单独配置，请在身份恢复中核实']])}<p class="hint">本地管理关系与云账号登录、数据访问登录分别记录。管理绑定成功不会自动获得已有文件和应用的访问权限。</p><button data-action="lock">锁定本地身份</button></section>`;
  if (model.view === 'first-root') return `<section class="card"><div class="eyebrow">仅用于具备独立交付凭据的新盒子</div><h2>首次绑定管理设备</h2><p>粘贴通过可信渠道收到的受保护交付材料。已有主人或数据的盒子不能通过此流程重新认领。</p><form data-form="prepareFirstRoot"><label>受保护交付材料<textarea name="deliveryPacket" rows="7" maxlength="8192" required autocomplete="off" spellcheck="false"></textarea></label><p class="hint">材料包含一次性秘密。提交核对后输入框立即清空，不会自动保存或复制。</p><button class="primary" type="submit">读取并核对盒子</button></form></section>`;
  if (model.view === 'join') return `<section class="card"><div class="eyebrow">在新的使用设备上操作</div><h2>申请设备权限</h2><p>先从已有管理设备的“设备清单”获取加入材料。加入范围由管理设备决定，申请设备不能修改盒子身份或提升权限。</p><form data-form="prepareJoin"><label>管理设备提供的加入材料<textarea name="joinInfo" rows="7" maxlength="32768" required spellcheck="false"></textarea></label><button class="primary" type="submit">核对使用设备申请</button></form></section>`;
  if (model.view === 'approval') return `<section class="card"><div class="eyebrow">在已有管理设备上操作</div><h2>核对并批准新设备</h2><p>粘贴申请设备生成的申请文本。随后将从已信任的盒子读取不可变申请，并展示准确权限。</p><form data-form="prepareApproval"><label>设备申请文本<textarea name="invitation" rows="7" maxlength="32768" required spellcheck="false"></textarea></label><button class="primary" type="submit">读取待批准申请</button></form></section>`;
  if (model.view === 'devices') return `<section class="card"><h2>设备清单</h2><p>从盒子读取当前有效绑定。使用设备不能批准其他设备。</p><form data-form="refreshDevices">${boxSelect(model)}<div class="actions"><button class="primary" type="submit">读取设备清单</button><button type="submit" name="operation" value="exportJoinInfo">生成加入材料</button></div></form>
    ${model.joinInfo ? `<label>提供给新设备的加入材料<textarea readonly rows="6" spellcheck="false">${escape(model.joinInfo)}</textarea></label><p class="hint">只包含公开描述及明确的身份和权限限制，不包含首次交付秘密。请通过可信渠道交给新设备。</p>` : ''}
    ${model.devices ? `<h3>${escape(model.devices.boxId)}</h3><div class="device-list">${model.devices.devices?.length ? model.devices.devices.map(device => `<article class="device"><h4>${escape(roles[device.role] || device.role)}</h4>${facts([['设备编号', id(device.clientId)], ['绑定编号', id(device.bindingId)], ['状态', escape(states[device.status] || device.status)], ['访问密钥指纹', id(device.accessKeyThumbprint)], ['有效期', escape(date(device.expiresAt))]])}</article>`).join('') : '<p class="muted">此盒子未返回设备记录。</p>'}</div>` : ''}</section>`;
  return `<section class="card"><div class="eyebrow">本地权限管理</div><h2>选择接下来要做的事</h2><div class="choices"><button data-view="first-root"><strong>首次绑定</strong><span>凭受保护交付材料建立首台管理设备</span></button><button data-view="join"><strong>申请新设备</strong><span>把这台设备加入已有本地身份</span></button><button data-view="approval"><strong>核对与批准</strong><span>在管理设备上核对新设备和权限</span></button><button data-view="devices"><strong>查看设备清单</strong><span>读取当前绑定，生成加入材料</span></button></div></section>${(state.requests || []).length ? `<section class="card"><h2>本机申请记录</h2>${state.requests.map(request => `<article class="request"><div><strong>${escape(states[request.state] || request.state)}</strong><p>${id(request.boxId)}</p></div><button data-action="refresh-request" data-box-id="${escape(request.boxId)}" data-request-id="${escape(request.requestId)}">查看结果</button></article>`).join('')}</section>` : ''}`;
}

export function renderDeviceTrust(model) {
  const unlocked = profileOpen(model.snapshot);
  return `<header><div><div class="eyebrow">万象 · 本地安全</div><h1>本地身份与设备权限</h1></div><span class="badge">${model.snapshot?.error ? '身份不可读取' : unlocked ? '已解锁' : model.snapshot?.profile ? '已锁定' : '尚未建立身份'}</span></header>
    <aside class="protection"><strong>软件口令保护</strong><p>密钥由本地口令加密保存，批准新设备需再次输入。身份恢复需另行配置并保存独立材料，请妥善保管口令。本地绑定与现有数据访问权限分别管理。</p></aside>
    <nav aria-label="本地权限管理">${Object.entries(labels).map(([view, label]) => `<button data-view="${view}" ${model.view === view ? 'aria-current="page"' : ''} ${model.busy || model.review || !unlocked ? 'disabled' : ''}>${label}</button>`).join('')}<button class="lock" data-action="lock" ${!unlocked ? 'disabled' : ''}>锁定</button></nav>
    ${model.notice ? `<p class="notice" role="alert">${escape(model.notice)}</p>` : ''}${model.busy ? '<p class="working" role="status">正在处理，请稍候…</p>' : ''}
    <div ${model.busy ? 'inert aria-busy="true"' : ''}>${content(model)}${unlocked && !model.review ? resultView(model.result) : ''}${unlocked && !model.review && model.view === 'overview' ? operationHistory(model.snapshot) : ''}</div>`;
}

const messages = { TEAM_CLOUD_LOGIN_REQUIRED: '请先在主窗口完成云端注册或登录。', TEAM_CLOUD_ACCOUNT_CHANGED: '云账号已变化，请重新核对申请。', TEAM_TARGET_CONSENT_REQUIRED: '等待申请设备核对最终清单并确认。对方完成后可再次提交同一操作。', TEAM_RESOURCE_APPROVAL_REQUIRED: '此资源尚未获得本机设备的明确批准。',
  LOCAL_TRUST_INVALID_INPUT: '输入格式不正确，请检查后重试。',
  LOCAL_TRUST_CONTEXT_CHANGED: '本地身份或核对上下文已变化，请重新解锁并核对。',
  LOCAL_TRUST_BUSY: '已有操作正在处理，请稍候。',
  LOCAL_TRUST_RATE_LIMITED: '盒子当前请求较多，请稍候再核实同一操作；不要重复创建任务。',
  LOCAL_TRUST_CAPACITY: '盒子当前可用操作容量不足，请稍候再核实原任务状态。',
  LOCAL_TRUST_OPERATION_UNAVAILABLE: '盒子的执行服务尚未就绪，请检查服务后核实原任务状态。',
  LOCAL_TRUST_OPERATION_DENIED: '当前身份、授权范围或任务资格不满足要求，操作已停止。',
  LOCAL_TRUST_OPERATION_UNKNOWN: '无法核实当前身份的此项任务，请保留本地操作记录。',
  LOCAL_TRUST_OPERATION_CONFLICT: '任务状态已经变化，请重新核实同一任务。',
  LOCAL_TRUST_OPERATION_TERMINAL: '此任务已结束，不能继续发送此步骤；请读取最终状态。',
  LOCAL_TRUST_OPERATION_BUSY: '此任务仍在执行，请稍候核实其进度。',
  LOCAL_TRUST_OPERATION_PHASE_INVALID: '任务当前不在所请求的阶段，请重新核实进度。',
  LOCAL_MANAGEMENT_TIMEOUT: '尚未及时收到盒子结果，请检查连接并核实原操作；超时不代表任务已取消。',
  LOCAL_TRUST_LOCKED: '本地身份已锁定，请重新解锁。',
  LOCAL_TRUST_PASSPHRASE_INVALID: '本地口令不正确，请重试。',
  LOCAL_IDENTITY_PASSPHRASE_INVALID: '本地口令至少需要 12 个字符，不能包含换行或控制字符。',
  LOCAL_IDENTITY_UNLOCK_FAILED: '无法解锁本地身份，请检查口令。请保留现有身份文件，不要重新建立身份。',
  LOCAL_IDENTITY_LOCKED: '本地身份已锁定，请重新解锁。',
  LOCAL_IDENTITY_CORRUPT: '本地身份文件不可读取，请保留现有文件并联系支持人员。',
  LOCAL_IDENTITY_STORAGE_UNAVAILABLE: '本地身份存储暂时不可用，请检查存储权限并保留现有身份文件。',
  LOCAL_TRUST_CLOCK_ROLLBACK: '盒子检测到时间回退，已暂停授权。请检查盒子的系统时间后重试。',
  LOCAL_TRUST_ALREADY_OWNED: '盒子已有本地主人，不能再次首次绑定。请由已有管理设备批准新设备。',
  LOCAL_TRUST_REVIEW_EXPIRED: '本次核对已过期，请重新读取并核对申请。',
  LOCAL_TRUST_CHECKPOINT_CHANGED: '盒子的权限或设备清单已变化，请重新读取并核对。',
  LOCAL_TRUST_MANAGER_REQUIRED: '当前设备没有管理权限，请在有效的管理设备上操作。',
  LOCAL_TRUST_BINDING_INACTIVE: '当前设备或成员资格已失效；历史成功回执不能恢复访问。',
  LOCAL_TRUST_CAPABILITY_REQUIRED: '此设备没有执行该操作的明确管理能力。',
  LOCAL_TRUST_ORIGINAL_OWNER_REQUIRED: '此操作仅能由当前有效的原始首台管理设备执行。',
  LOCAL_LEDGER_EFFECTS_CHANGED: '操作影响与签名摘要不一致，已停止提交。',
  LOCAL_LEDGER_SCOPE_MISMATCH: '返回记录不属于当前本地身份，已停止读取。',
  LOCAL_TRUST_TARGET_CHANGED: '最终清单中的设备密钥与本机不一致，已停止确认。',
  LOCAL_RECOVERY_REIMPORT_REQUIRED: '请通过文件选择器重新导入刚保存的恢复材料，验证后再继续。',
  LOCAL_RECOVERY_SCOPE_MISMATCH: '恢复材料的盒子、身份、版本或密钥不匹配，已停止操作。',
  LOCAL_RECOVERY_MATERIAL_INVALID: '恢复材料格式或密钥验证失败，请保留原文件并检查选取的材料。',
  LOCAL_RECOVERY_NEW_DEVICE_REQUIRED: '恢复身份需要新的本地设备密钥，请在全新本地身份上进行。',
  LOCAL_RECOVERY_MATERIAL_EXPIRED: '本次恢复材料操作已失效，请重新选择文件并核对。',
  LOCAL_BACKUP_FILE_INVALID: '备份文件读取或保存未完成。请检查文件是否变化、目录权限、目标是否已存在以及磁盘是否支持安全保存；已有目标不会被覆盖。',
  LOCAL_BACKUP_NAMESPACE_UNAVAILABLE: '当前身份的私人空间尚未就绪或缺少所需访问权限。请先解锁并核实盒子本地连接，不能用云账号或其他身份替代。',
  LOCAL_BACKUP_RECOVERY_REQUIRED: '请先为目标盒子的当前身份配置并验证独立恢复材料。',
  LOCAL_BACKUP_SOURCE_EXPIRED: '本次备份来源检查已失效，请重新选择材料和备份文件。',
  LOCAL_BACKUP_SOURCE_INVALID: '所选文件不是可验证的加密业务备份，文件未上传。请勿将恢复材料或私钥文件选作业务备份。',
  LOCAL_BACKUP_SOURCE_CHANGED: '备份来源、密钥或完整摘要不一致，已停止操作。',
  LOCAL_BACKUP_KEY_NOT_REQUESTED: '该任务当前没有等待解密密钥，请核实任务进度。',
  LOCAL_TRANSFER_STATUS_CHANGED: '返回的转移状态与已保存的签名历史不一致，已停止显示完成结果。请保留本地身份记录并核查盒子。',
  LOCAL_TRANSFER_SCOPE_CHANGED: '清除范围或受影响成员数量已变化，已停止提交；请重新读取并核对完整范围。',
  LOCAL_BACKUP_NOT_COMPLETED: '尚无已经核验完成的备份，暂时不能另存。',
  LOCAL_TRUST_MIGRATION_PROOF_REQUIRED: '该盒子需要独立的原主人证明，当前流程不会覆盖已有数据或身份。',
};
export function createDeviceTrustView({ root, api, FormDataClass = globalThis.FormData }) {
  const model = { snapshot: null, view: 'overview', boxId: null, review: null, result: null, devices: null, security: null, members: null, joinInfo: null,
    team: null, teamInvitation: null, targetInfo: null, reviewHandoff: null, material: null, recoveryImport: null, backupTargets: null, backupSource: null, backupProfile: null,
    enrollmentKind: 'prepareManagerEnrollment', notice: '', busy: false };
  let generation = 0, initialized = false, disposed = false;
  const render = () => { if (!disposed) root.innerHTML = renderDeviceTrust(model); };
  const clearTransient = () => { model.review = null; model.result = null; model.devices = null; model.security = null; model.members = null; model.joinInfo = null;
    model.team = null; model.teamInvitation = null; model.resourceInfo = null; model.targetInfo = null; model.reviewHandoff = null; model.material = null; model.recoveryImport = null;
    model.backupTargets = null; model.backupSource = null; model.backupProfile = null; };
  async function snapshot() {
    const current = generation;
    const state = await api.snapshot();
    if (disposed || current !== generation) return;
    model.snapshot = state;
    if (!initialized) { model.view = labels[state.window?.view] ? state.window.view : 'overview'; model.boxId = state.window?.boxId || null; initialized = true; }
    if (!profileOpen(state)) clearTransient();
  }
  async function run(method, input = {}) {
    if (model.busy && method !== 'lock') return;
    const current = ++generation;
    if (method === 'lock') clearTransient();
    model.busy = true; model.notice = ''; render();
    try {
      const value = await api[method](input);
      if (current !== generation || disposed) return;
      if (method.startsWith('prepare')) { model.review = value; model.result = null; model.reviewHandoff = null; }
      else if (method === 'exportJoinInfo') model.joinInfo = value.joinInfo;
      else if (method === 'refreshDevices') { model.devices = value; model.boxId = input.boxId; }
      else if (method === 'refreshSecurityState') { model.security = value; model.boxId = input.boxId; model.members = null; }
      else if (method === 'refreshTeam') { model.team = value; model.boxId = input.boxId; }
      else if (method === 'exportTeamInvitation') model.teamInvitation = value.invitation;
      else if (method === 'exportTeamDeviceResourceInfo') model.resourceInfo = value.resourceInfo;
      else if (method === 'refreshTeamRequest' && value.kind === 'team-target') model.review = value;
      else if (['submitTeamJoin', 'refreshTeamRequest', 'confirmTeamConsent', 'refreshTeamAssociation'].includes(method)) { model.review = null; model.result = { ...value, teamOperation: true }; }
      else if (method === 'refreshMembers') model.members = value;
      else if (method === 'refreshBackupTargets') { model.backupTargets = value; model.boxId = input.boxId; model.backupProfile = value.targets[0]?.scopeProfiles.length === 1 ? value.targets[0].scopeProfiles[0] : null; }
      else if (method === 'importBackupSource') { model.backupSource = value; model.boxId = input.boxId; }
      else if (['refreshBackupOperation', 'saveBackupArchive'].includes(method)) {
        if (value) model.result = { ...value, backupOperation: true };
      }
      else if (method === 'provideRestoreKey') { if (value) model.result = { ...model.result, ...value, backupOperation: true }; }
      else if (['confirmSecurityMutation', 'refreshSecurityMutation', 'confirmIdentityRecovery', 'acceptEnrollmentReceipt'].includes(method)) {
        model.review = null; model.result = { ...value, securityOperation: true }; model.security = null; model.members = null;
        if (value.state === 'committed' || value.state === 'outcome_unknown') { model.material = null; model.recoveryImport = null; model.backupSource = null; }
      }
      else if (method === 'refreshOwnershipTransfer') { model.result = value; model.review = null; }
      else if (method === 'refreshDataEffect') model.result = { ...model.result, ...value, securityOperation: true };
      else if (method === 'exportTargetInfo') model.targetInfo = value;
      else if (method === 'exportTargetReview') model.reviewHandoff = value.reviewHandoff;
      else if (method === 'importTargetProofs') model.review = value;
      else if (['confirmTargetApproval', 'resumeTargetApproval'].includes(method)) { model.review = null; model.result = value; }
      else if (method === 'exportSecurityReceipt') model.result = { ...model.result, receipt: value.receipt };
      else if (['beginRecoveryConfiguration', 'beginIdentityRecovery'].includes(method)) model.material = value;
      else if (['exportRecoveryMaterial', 'reimportRecoveryMaterial'].includes(method)) model.material = { ...model.material, ...value };
      else if (method === 'importIdentityRecovery') { model.recoveryImport = value; model.material = null; }
      else if (['confirmFirstRoot', 'confirmApproval', 'submitJoin', 'refreshRequest', 'cancelRequest'].includes(method)) {
        model.review = null; model.result = value;
      }
      await snapshot();
    } catch (error) {
      if (current !== generation || disposed) return;
      // Electron's contextBridge does not preserve custom Error properties.
      model.notice = messages[error?.code || error?.message] || '操作未完成，请检查本地口令、盒子连接和申请有效期后重试。';
      // A failed confirmation never displays a stale success or reusable review.
      if ((method.startsWith('confirm') || method === 'submitJoin') && (error?.code || error?.message) !== 'TEAM_TARGET_CONSENT_REQUIRED') model.review = null;
      try { await snapshot(); } catch { /* Keep the safe error message. */ }
    } finally {
      if (current === generation && !disposed) { model.busy = false; render(); }
    }
  }
  async function click(event) {
    const target = event.target.closest?.('[data-view], [data-action]');
    if (!target || !root.contains(target)) return;
    const action = target.dataset.action;
    if (action === 'lock') { await run('lock'); return; }
    if (!model.busy && model.review && action === 'export-target-review') { await run('exportTargetReview', { reviewHandle: model.review.reviewHandle }); return; }
    if (model.busy || model.review) return;
    if (target.dataset.view && labels[target.dataset.view]) { model.view = target.dataset.view; model.notice = ''; model.result = null; render(); return; }
    if (action === 'team-knowledge-create') await run('prepareTeamKnowledgeResource', { boxId: model.team.boxId });
    if (action === 'team-device-resource') await run('prepareTeamDeviceResource', { boxId: model.team.boxId, resourceId: target.dataset.resourceId });
    if (action === 'team-request') await run('refreshTeamRequest', { boxId: target.dataset.boxId, requestId: target.dataset.requestId });
    if (action === 'team-admit') await run('prepareTeamAdmission', { boxId: model.team.boxId, requestId: target.dataset.requestId });
    if (action === 'team-invite-export') await run('exportTeamInvitation', { boxId: target.dataset.boxId, requestId: target.dataset.requestId });
    if (action === 'team-invite-revoke') await run('prepareTeamInviteRevocation', { boxId: model.team.boxId, invitationId: target.dataset.invitationId });
    if (['team-suspend', 'team-revoke'].includes(action)) await run(action === 'team-suspend' ? 'prepareTeamMemberSuspension' : 'prepareTeamMemberRevocation', { boxId: model.team.boxId, principalId: target.dataset.principalId });
    if (action === 'refresh-request' || action === 'cancel-request')
      await run(action === 'refresh-request' ? 'refreshRequest' : 'cancelRequest', { boxId: target.dataset.boxId, requestId: target.dataset.requestId });
    if (action === 'refresh-security-operation' || action === 'refresh-data-effect')
      await run(action === 'refresh-data-effect' ? 'refreshDataEffect' : 'refreshSecurityMutation', { boxId: target.dataset.boxId, requestId: target.dataset.requestId });
    if (action === 'refresh-transfer-status') await run('refreshOwnershipTransfer', { boxId: target.dataset.boxId, requestId: target.dataset.requestId });
    if (action === 'resume-target-approval') await run('resumeTargetApproval', { boxId: target.dataset.boxId, requestId: target.dataset.requestId });
    const backupAction = { 'refresh-backup-operation': 'refreshBackupOperation', 'save-backup-archive': 'saveBackupArchive', 'provide-restore-key': 'provideRestoreKey' }[action];
    if (backupAction) await run(backupAction, { boxId: target.dataset.boxId, requestId: target.dataset.requestId });
    if (action === 'prepare-backup-restore' && model.backupSource) await run('prepareBackupRestore', { sourceHandle: model.backupSource.sourceHandle });
    if (model.security && ['revoke-device', 'emergency-revoke'].includes(action))
      await run('prepareDeviceRevocation', { boxId: model.security.boxId, bindingId: target.dataset.bindingId, mode: action === 'emergency-revoke' ? 'emergency-lock' : 'normal' });
    if (model.security && action === 'review-descendant') await run('prepareDescendantReview', { boxId: model.security.boxId, bindingIds: [target.dataset.bindingId] });
    if (model.security && action === 'refresh-members') await run('refreshMembers', { boxId: model.security.boxId });
    if (model.security && action === 'revoke-member') await run('prepareMemberRevocation', { boxId: model.security.boxId, principalId: target.dataset.principalId });
    if (action === 'export-target-info') await run('exportTargetInfo');
    if (action === 'export-security-receipt') await run('exportSecurityReceipt', { boxId: target.dataset.boxId, requestId: target.dataset.requestId });
    if (action === 'import-identity-recovery') await run('importIdentityRecovery');
    if (action === 'begin-identity-recovery' && model.recoveryImport) await run('beginIdentityRecovery', { recoveryHandle: model.recoveryImport.recoveryHandle });
    if (model.material && ['export-recovery-material', 'reimport-recovery-material', 'prepare-recovery'].includes(action)) {
      const method = action === 'export-recovery-material' ? 'exportRecoveryMaterial' : action === 'reimport-recovery-material' ? 'reimportRecoveryMaterial'
        : model.material.operation === 'recovery.recover' ? 'prepareIdentityRecovery' : 'prepareRecoveryConfiguration';
      await run(method, { materialHandle: model.material.materialHandle });
    }
  }
  async function submit(event) {
    const form = event.target;
    if (!form?.dataset?.form) return;
    event.preventDefault();
    if (model.busy) return;
    const data = Object.fromEntries(new FormDataClass(form));
    const name = form.dataset.form;
    // Do not keep passwords or delivery secrets in DOM nodes while awaiting IPC.
    form.reset();
    if (name === 'createProfile') {
      if (data.passphrase !== data.repeatPassphrase) { model.notice = '两次输入的本地口令不一致，请重新输入。'; render(); return; }
      await run(name, { passphrase: data.passphrase });
    } else if (name === 'prepareTeamJoin') await run(name, { invitation: data.invitation.trim(), deviceId: data.deviceId.trim() });
    else if (['prepareTeamActivation', 'prepareTeamLink'].includes(name)) await run(name, { boxId: data.boxId, deviceId: data.deviceId.trim() });
    else if (name === 'prepareTeamRemoteDeviceResource') await run(name, { boxId: data.boxId, resourceId: data.resourceId, resourceInfo: data.resourceInfo.trim() });
    else if (['refreshTeam', 'refreshTeamAssociation', 'exportTeamDeviceResourceInfo'].includes(name)) await run(name, { boxId: data.boxId });
    else if (name === 'prepareTeamMemberRole') await run(name, { boxId: model.team.boxId, principalId: data.principalId, roleId: data.roleId });
    else if (name === 'prepareTeamResourceAccess' && model.team) { const selected = {}; for (const [key, value] of Object.entries(data)) if (key.startsWith('acl:') && value === 'on') { const principalId = key.slice(4, key.lastIndexOf(':')); (selected[principalId] ||= []).push(key.slice(key.lastIndexOf(':') + 1)); } await run(name, { boxId: model.team.boxId, resourceId: data.resourceId, grants: Object.entries(selected).sort(([a], [b]) => a < b ? -1 : 1).map(([principalId, actions]) => ({ principalId, actions: actions.sort() })) }); }
    else if (name === 'prepareTeamInvite' && model.team) {
      const selected = {}; for (const [key, value] of Object.entries(data)) if (key.startsWith('grant:') && value === 'on') { const resource = key.slice(6, key.lastIndexOf(':')); (selected[resource] ||= []).push(key.slice(key.lastIndexOf(':') + 1)); }
      await run(name, { boxId: model.team.boxId, roleId: data.roleId, capabilities: data.allowDeviceApproval === 'on' ? ['device.approve_use'] : [], grants: Object.entries(selected).sort(([a], [b]) => a < b ? -1 : 1).map(([resourceId, actions]) => ({ resourceId, actions: actions.sort() })), delegableGrants: data.allowDeviceApproval === 'on' ? Object.entries(selected).sort(([a], [b]) => a < b ? -1 : 1).map(([resourceId, actions]) => ({ resourceId, actions: actions.sort() })) : [], expiresAt: Math.floor(Date.now() / 1000) + 86400, delegationExpiresAt: null });
    } else if (name === 'unlock') await run(name, { passphrase: data.passphrase });
    else if (name === 'confirm-review') {
      if (!model.review || data.reviewed !== 'on') return;
      const review = model.review;
      if (review.action === 'ownership.transfer-prepare' && data.eraseConfirmation !== '清除本地数据') { model.notice = '请逐字输入“清除本地数据”，并核对所有成员的数据影响。'; render(); return; }
      const method = { 'team-join': 'submitTeamJoin', 'team-target': 'confirmTeamConsent', 'first-root': 'confirmFirstRoot', join: 'submitJoin', approval: 'confirmApproval', 'ledger-mutation': 'confirmSecurityMutation', 'ledger-target': 'confirmTargetApproval', 'ledger-recovery': 'confirmIdentityRecovery' }[review.kind];
      if (method) await run(method, { reviewHandle: review.reviewHandle, ...(method !== 'submitJoin' ? { passphrase: data.passphrase } : {}) });
    } else if (name === 'refreshDevices') {
      model.boxId = data.boxId;
      await run(event.submitter?.value === 'exportJoinInfo' ? 'exportJoinInfo' : name, { boxId: data.boxId });
    } else if (['refreshSecurityState', 'beginRecoveryConfiguration', 'refreshBackupTargets', 'importBackupSource', 'prepareOwnershipTransfer'].includes(name)) await run(name, { boxId: data.boxId });
    else if (name === 'prepareBackupCreate' && model.backupTargets) await run(name, { boxId: model.backupTargets.boxId,
      targetId: data.targetId, scopeProfile: data.scopeProfile, includeBusinessSecrets: data.includeBusinessSecrets === 'on' });
    else if (name === 'prepareActivatePolicy' && model.security) {
      const capabilities = [...new Set(['device.approve_use', ...Object.keys(data).filter(key => key.startsWith('cap:') && data[key] === 'on').map(key => key.slice(4))])].sort();
      await run(name, { boxId: model.security.boxId, capabilities });
    } else if (name === 'importTargetProofs' && model.review) await run(name, { reviewHandle: model.review.reviewHandle, targetProofs: data.targetProofs.trim() });
    else if (name === 'prepareTargetApproval') await run(name, { reviewHandoff: data.reviewHandoff.trim() });
    else if (name === 'acceptEnrollmentReceipt' && model.result) await run(name, { boxId: model.result.boxId, requestId: model.result.requestId, receipt: data.receipt.trim() });
    else if (name === 'prepare-enrollment' && model.security) {
      const list = prefix => {
        const selected = {};
        for (const [key, value] of Object.entries(data)) if (key.startsWith(prefix) && value === 'on') {
          const resource = key.slice(prefix.length, key.lastIndexOf(':')), action = key.slice(key.lastIndexOf(':') + 1);
          (selected[resource] ||= []).push(action);
        }
        return Object.entries(selected).sort(([a], [b]) => a.localeCompare(b)).map(([resourceId, actions]) => ({ resourceId, actions: actions.sort() }));
      };
      const method = data.operation === 'prepareMemberInvitation' ? data.operation : 'prepareManagerEnrollment';
      await run(method, { boxId: model.security.boxId, targetInfo: data.targetInfo.trim(),
        capabilities: Object.keys(data).filter(key => key.startsWith('cap:') && data[key] === 'on').map(key => key.slice(4)).sort(),
        grants: list('grant:'), delegableGrants: list('delegate:'),
        expiresAt: data.expiresAt ? Math.floor(Date.parse(data.expiresAt) / 1000) : null,
        delegationExpiresAt: data.delegationExpiresAt ? Math.floor(Date.parse(data.delegationExpiresAt) / 1000) : null });
    } else {
      const key = { prepareFirstRoot: 'deliveryPacket', prepareJoin: 'joinInfo', prepareApproval: 'invitation' }[name];
      if (key) await run(name, { [key]: String(data[key] || '').trim() });
    }
  }
  root.addEventListener('click', click);
  root.addEventListener('submit', submit);
  const change = event => {
    if (!model.busy && !model.review && event.target?.name === 'scopeProfile'
      && event.target.closest?.('[data-form="prepareBackupCreate"]')) {
      model.backupProfile = Object.hasOwn(backupProfileLabels, event.target.value) ? event.target.value : null; render();
    }
    if (!model.busy && !model.review && event.target?.name === 'operation'
      && event.target.closest?.('[data-form="prepare-enrollment"]')) {
      model.enrollmentKind = event.target.value === 'prepareMemberInvitation' ? event.target.value : 'prepareManagerEnrollment';
      render();
    }
  };
  root.addEventListener('change', change);
  const unsubscribe = api.onChanged?.(() => {
    generation++; model.busy = false; clearTransient(); initialized = false;
    if (model.snapshot?.profile) model.snapshot = { ...model.snapshot, profile: { ...model.snapshot.profile, locked: true } };
    render();
    void snapshot().then(render).catch(() => { model.notice = '本地状态暂时不可用，请关闭窗口后重新打开。'; render(); });
  });
  const ready = snapshot().then(render).catch(() => { model.notice = '无法读取本地身份，请关闭窗口后重新打开。'; render(); });
  return { ready, dispose() { disposed = true; generation++; unsubscribe?.(); root.removeEventListener('click', click); root.removeEventListener('submit', submit); root.removeEventListener('change', change); } };
}

if (typeof document !== 'undefined' && globalThis.wanxDeviceTrust) {
  const view = createDeviceTrustView({ root: document.querySelector('#app'), api: globalThis.wanxDeviceTrust });
  globalThis.addEventListener('pagehide', () => view.dispose(), { once: true });
}
