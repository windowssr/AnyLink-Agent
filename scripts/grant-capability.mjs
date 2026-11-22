import fs from 'node:fs';import {randomUUID} from 'node:crypto';import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{server:{type:'string',default:process.env.ANYLINK_BASE_URL??'http://127.0.0.1:3180'},'owner-token-file':{type:'string'},source:{type:'string'},target:{type:'string'},capability:{type:'string'},revoke:{type:'boolean',default:false}}});
if(!values['owner-token-file']||!values.source||!values.target||!values.capability)throw new Error('Required: --owner-token-file FILE --source UUID --target UUID --capability text.reverse [--revoke] [--server URL]');
const base=new URL(values.server);if(base.username||base.password||base.search||base.hash||!['http:','https:'].includes(base.protocol)||(base.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(base.hostname)))throw new Error('Use HTTPS or a loopback tunnel without URL credentials');
const request=(url,options)=>fetch(new URL(url,base.href.replace(/\/$/,'')+'/'),{...options,redirect:'error',signal:AbortSignal.timeout(15000)});
const response=await request('v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:fs.readFileSync(values['owner-token-file'],'utf8').trim()})});
if(!response.ok)throw new Error('Owner login failed: HTTP '+response.status);
const cookie=response.headers.get('set-cookie')?.split(';')[0];if(!cookie)throw new Error('Owner login did not return a session');
try{
 const result=await request('v1/link/grants',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'Idempotency-Key':randomUUID()},body:JSON.stringify({source_device_id:values.source,target_device_id:values.target,capability:values.capability,enabled:!values.revoke})});
 if(!result.ok)throw new Error('Grant operation failed: HTTP '+result.status);
 console.log(JSON.stringify(await result.json(),null,2));
}finally{await request('v1/auth/logout',{method:'POST',headers:{Cookie:cookie}}).catch(()=>{});}
