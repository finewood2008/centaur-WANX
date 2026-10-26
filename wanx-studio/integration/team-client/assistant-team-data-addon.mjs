// Preserve the installed Starlink service and its current authorization checks.
export function assistantAwareTeamDataService(createOriginal, options) {
  const service = createOriginal(options);
  return { ...service, async action(action, input = {}) {
    if (!['assistant-access', 'assistant-access-update'].includes(action)) return service.action(action, input);
    const wid = input.warehouseId;
    if (typeof wid !== 'string' || !/^[a-f0-9-]{36}$/.test(wid)) throw Object.assign(Error('TEAM_DATA_TARGET_INVALID'), {code:'TEAM_DATA_TARGET_INVALID'});
    const link = await service.connection();
    const response = await link.request({path:'/api/assistant/knowledge/access/'+wid,method:action==='assistant-access'?'GET':'PUT',
      ...(action==='assistant-access-update'?{headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify({audience:input.audience,members:input.members,revision:input.revision}))}:{})});
    link.context();
    let value;try {value=JSON.parse(response.body.toString())}catch {throw Error('TEAM_DATA_RESPONSE_INVALID')}
    if(response.status<200||response.status>=300){const code=value.detail?.code||value.error?.code||'TEAM_DATA_ACTION_DENIED';throw Object.assign(Error(code),{code})}
    return value;
  }};
}
