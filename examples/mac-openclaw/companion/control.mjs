import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';

export const controlActions=['status','configure','quiet','walk','pet','resize','reset_position','reload','show','hide','open_chat','open_voice','stop_speaking','chat_now','credits'];
export function controlChannel(ctx){return ctx.messageChannel??ctx.channel??ctx.deliveryContext?.channel;}
export function validateControl(value){
  if(!value||!controlActions.includes(value.action))throw new Error('Unsupported companion action');
  const fields={configure:['roaming','proactive','read_aloud'],quiet:['minutes'],resize:['scale']}[value.action]??[];
  if(Object.keys(value).some(key=>!['action',...fields].includes(key)))throw new Error('Unexpected companion parameter');
  if(value.action==='configure'&&(!fields.some(key=>key in value)||fields.some(key=>key in value&&typeof value[key]!=='boolean')))throw new Error('Explicit boolean settings required');
  if(value.action==='quiet'&&(!Number.isInteger(value.minutes)||value.minutes<0||value.minutes>720))throw new Error('Quiet minutes must be 0..720');
  if(value.action==='resize'&&![0.8,1,1.25].includes(value.scale))throw new Error('Scale must be 0.8, 1 or 1.25');
  return value;
}
export function allowedControl(ctx,value){
  const channel=controlChannel(ctx);
  return ['main','companion'].includes(ctx.agentId)&&(!channel||['webchat','web','openai-http'].includes(channel))&&(ctx.agentId==='main'||['status','walk'].includes(value.action));
}
export async function sendControl(root,ctx,callId,parameters,{now=()=>Date.now(),timeout=10000}={}){
  const command=validateControl(parameters);
  if(!allowedControl(ctx,command))throw new Error('This conversation cannot change desktop preferences');
  const folder=path.join(root,'data/mac/companion/control'),requests=path.join(folder,'requests'),receipts=path.join(folder,'receipts');
  const id=createHash('sha256').update([ctx.agentId,ctx.sessionKey,ctx.runId,callId].join('\0')).digest('hex');
  const receipt=path.join(receipts,id+'.json');
  const read=()=>{try{return JSON.parse(fs.readFileSync(receipt,'utf8'));}catch{return null;}};
  const prior=read();if(prior)return prior;
  let lease;try{lease=JSON.parse(fs.readFileSync(path.join(folder,'presence.json'),'utf8'));}catch{}
  if(lease?.enabled!==true||typeof lease.epoch!=='string'||!Number.isFinite(lease.expires_at)||lease.expires_at<now()||lease.expires_at>now()+60000)return {status:'desktop_unavailable',applied:false};
  fs.mkdirSync(requests,{recursive:true,mode:0o700});
  const created=now(),request={id,epoch:lease.epoch,created_at:created,expires_at:created+12000,command};
  // Exclusive publication and a stable tool-call ID reconcile retries without
  // toggles or repeated movement. Never replace a pending command.
  const temporary=path.join(requests,id+'.tmp-'+process.pid),file=path.join(requests,id+'.json');
  if(!fs.existsSync(file)){
    ctx.assertInvocationCurrent?.();
    fs.writeFileSync(temporary,JSON.stringify(request),{mode:0o600});
    try{fs.linkSync(temporary,file);}catch(error){if(error.code!=='EEXIST')throw error;}finally{fs.rmSync(temporary,{force:true});}
  }
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const result=read();if(result)return result;await sleep(80);}
  return {status:'result_unknown',applied:null,request_id:id,detail:'No automatic replay. Query status before requesting another change.'};
}
