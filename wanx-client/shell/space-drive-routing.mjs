// Private disks reuse the normal transfer manager without routing company data
// through another member's personal API. This cache only locates resources;
// the server rechecks the disk root and the current human on every operation.
export function createDriveRouting({catalog, scope, send}) {
  let bound, disks = new Map(), items = new Map(), pending;
  const fail = code => Object.assign(Error(code), {code});
  async function refresh() {
    const context = scope();
    if (bound !== context) {bound=context;disks.clear();items.clear();pending=null;}
    if (!catalog) return;
    if (!pending) pending = Promise.resolve(catalog()).then(values=>{
      if (context!==scope()) throw fail('SPACE_CONTEXT_CHANGED');
      disks=new Map(values.map(d=>[d.id,d]));
      for(const d of values)for(const id of [d.root,...Object.values(d.directories||{})])items.set(id,d.id);
    }).catch(e=>{pending=null;throw e;});
    await pending;
  }
  async function route(path, options={}) {
    if(!catalog)return {handled:false};
    await refresh();
    const u=new URL(path,'http://space'), parts=u.pathname.split('/').filter(Boolean), method=options.method||'GET', body=options.body||{};
    const sid=options.spaceId||body.space_id||u.searchParams.get('space_id');
    const target=parts[1]||body.id||body.parent||u.searchParams.get('parent');
    const disk=disks.get(sid)||disks.get(items.get(target));
    if(!disk){if(sid&&sid!=='personal')throw fail('MCP_DRIVE_NOT_READY');return {handled:false};}
    const params={...(Buffer.isBuffer(body)?{}:body),...Object.fromEntries(u.searchParams)};
    if(parts[1])params.id=parts[1];
    let action;
    if(parts[0]==='files')action=parts[2]==='content'?'read':parts[2]==='previous'?'previous':parts[1]?({GET:'stat',PATCH:'move',DELETE:'trash'}[method]):'list';
    if(parts[0]==='folders')action='mkdir';
    if(parts[0]==='trash')action=parts[2]==='restore'?'restore':'purge';
    if(parts[0]==='uploads'){
      action=parts[2]==='complete'?'upload-complete':!parts[1]?'upload-create':({GET:'upload-status',PUT:'upload-chunk',DELETE:'upload-cancel'}[method]);
      if(method==='PUT'){params.data=Buffer.from(body).toString('base64');params.digest=options.headers?.['x-content-sha256'];}
    }
    if(!action)throw fail('SPACE_ACTION_INVALID');
    for(const k of ['offset','length','size'])if(params[k]!==undefined)params[k]=Number(params[k]);
    params.trash=params.trash===true||params.trash==='true';
    const context=scope();
    const value=await send(disk.connection_id,action,params,options.signal);
    if(context!==scope())throw fail('SPACE_CONTEXT_CHANGED');
    for(const i of [value,...(value?.items||[])])if(i?.id)items.set(i.id,disk.id);
    if(action==='upload-create')items.set(body.id,disk.id);
    if(action==='read')return {handled:true,value:{bytes:Buffer.from(value.data,'base64'),headers:{'x-content-sha256':value.chunkDigest,'x-file-sha256':value.info.digest,'x-file-version':String(value.info.version)}}};
    return {handled:true,value};
  }
  return {route,invalidate(){pending=null;},remember(item,sid){if(sid&&sid!=='personal')items.set(item,sid);}};
}
