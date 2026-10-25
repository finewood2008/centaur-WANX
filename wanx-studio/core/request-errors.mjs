// Electron wraps transport exceptions; keep protocol codes stable across IPC.
export function requestErrorCode(value){
 const raw=value instanceof Error?value.message:String(value),codes=raw.match(/\b[A-Z][A-Z_]{3,}\b/g)||[];
 const code=codes.at(-1);
 if(code&&code!=='ABORT_ERR')return code;
 if(['AbortError','TimeoutError'].includes(value?.name)||/\b(?:AbortError|TimeoutError|ABORT_ERR)\b|operation was aborted|operation was aborted due to timeout/i.test(raw))return'HOST_REQUEST_TIMEOUT';
 return code||raw;
}
export function transientRequestError(value){return['HOST_REQUEST_TIMEOUT','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','NETWORK_CHANGED'].includes(requestErrorCode(value))}
export function receivedOperation(project,operation){return Boolean(operation&&(project?.messages?.some(m=>m.operationId===operation)||project?.preparation?.interview?.turns?.some(t=>t.operationId===operation)))}
