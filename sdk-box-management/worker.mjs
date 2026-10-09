import {createInterface} from 'node:readline';
import {createBoxManagementHost} from './host.mjs';
const host=createBoxManagementHost({baseURL:process.env.WANX_CONSUMER_BASE_URL});
const safeErrors=new Set(['INVALID_INPUT','LOGIN_REQUIRED','DEVICE_NOT_AUTHORIZED','CONFIRMATION_REQUIRED','UPDATE_UNAVAILABLE','UNKNOWN_ACTION']);
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of lines) {
  let envelope;
  try {if(line.length>65536) throw new Error('INVALID_INPUT');envelope=JSON.parse(line);const result=await host.action(envelope.actor,envelope.action,envelope.input);process.stdout.write(JSON.stringify({id:envelope.id,ok:true,result})+'\n');}
  catch(error) {process.stdout.write(JSON.stringify({id:envelope?.id,ok:false,code:safeErrors.has(error.message)?error.message:'PLATFORM_REQUEST_FAILED'})+'\n');}
}
host.close();
