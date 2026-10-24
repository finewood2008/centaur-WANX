// Fixed bridge shared by the embedded workspace and its focused policy tests.
export function studioRoute(raw,method='GET'){
 if(typeof raw!=='string'||/[\\%#]/.test(raw)||!['GET','POST','PUT','DELETE'].includes(method))throw Error('STUDIO_PATH_DENIED');
 const url=new URL(raw,'http://studio.invalid');
 if(url.origin!=='http://studio.invalid'||!url.pathname.startsWith('/api/app-studio/')||url.username||url.password)throw Error('STUDIO_PATH_DENIED');
 const tail=url.pathname.slice(16);
 if(/^_builder\/projects\/[a-f0-9]{32}\/restore-version$/.test(tail)&&method==='POST')return url.pathname;
 if(tail==='_builder/context'&&method==='GET')return url.pathname+url.search;
 if(/^_builder\/projects\/[a-f0-9]{32}\/edits\/(stop|heartbeat)$/.test(tail)&&method==='POST')return url.pathname;
 if(/^_builder\/projects\/[a-f0-9]{32}\/edits$/.test(tail)&&['GET','POST'].includes(method))return url.pathname+url.search;
 if(/^_builder\/projects\/[a-f0-9]{32}\/edits\/[a-f0-9]{32}\/(answer|retry|stop)$/.test(tail)&&method==='POST')return url.pathname+url.search;
 if(/^_builder\/projects\/[a-f0-9]{32}\/(proposal|build)$/.test(tail)&&((tail.endsWith('/proposal')&&method==='GET')||(tail.endsWith('/build')&&method==='POST')))return url.pathname+url.search;
 if(!/^(context|preflight|capabilities|files|engines(?:\/default|\/check)?|context\/sources|projects(?:\/[a-f0-9]{32}(?:\/(?:intake(?:\/handoff|\/events)?|context(?:\/read|\/search)?|engine|capabilities(?:\/check|\/decisions)?|interview(?:\/turns|\/events|\/start)?|chat|solution|confirm|decisions|build|feedback|iterations|adopt|versions(?:\/[a-f0-9]{64}(?:\/restore-check)?)?|restore-version|tasks\/[A-Za-z0-9_-]+(?:\/events|\/cancel|\/answer)?|runtime|install\/[a-f0-9]{64}))?)?|runtime\/[A-Za-z0-9_-]+(?:\/invoke|\/files)?)$/.test(tail))throw Error('STUDIO_PATH_DENIED');
 return url.pathname+url.search;
}
export function scopeKey(c){return JSON.stringify([c.accountId,c.boxId,c.user?.id])}
export function validatePlacement(input){
 if(input?.protocolVersion!==1||!['show','hide','detach','attach'].includes(input.action))throw Error('WORKSPACE_OPERATION_DENIED');
 return input.action;
}
