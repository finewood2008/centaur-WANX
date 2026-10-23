function requestTimeout(target,method,body){
  // An interview can make one counted structure-repair request (2 x 180s).
  if(method==='POST'&&/^\/api\/app-studio\/projects\/[a-f0-9]{32}\/(?:chat|interview\/start)$/.test(target))return 390000;
  if(method==='POST'&&/^\/api\/app-studio\/runtime\/[A-Za-z0-9_-]+\/invoke$/.test(target)&&body?.method==='model.generate')return 210000;
  if(method==='POST'&&/^\/api\/app-studio\/projects\/[a-f0-9]{32}\/(?:intake|capabilities\/check)$/.test(target))return 240000;
  if(target==='/api/app-studio/preflight')return 60000;
  return undefined;
}
module.exports={requestTimeout};
