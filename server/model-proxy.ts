import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError,type Db,transaction } from './db.js';
import type { Config } from './config.js';
export const MODEL='deepseek-flash';
export const modelInputSchema=z.object({
  model:z.literal(MODEL),messages:z.array(z.object({role:z.enum(['system','developer','user','assistant','tool']),content:z.unknown().optional()}).passthrough()).min(1).max(1000),
  stream:z.boolean().optional(),max_tokens:z.number().int().min(1).max(8192).optional(),max_completion_tokens:z.number().int().min(1).max(8192).optional(),
  tools:z.array(z.unknown()).max(100).optional(),n:z.literal(1).optional(),
}).passthrough();
export function registerModelProxy(app:FastifyInstance,db:Db,config:Config) {
  const active=new Map<string,AbortController>();
  app.get('/model/v1/models',async()=>({object:'list',data:config.deepseekApiKey?[{id:MODEL,object:'model',owned_by:'deepseek',input_modalities:['text','image']}]:[]}));
  app.post('/model/v1/chat/completions',{bodyLimit:16*1024*1024},async(req,reply)=>{
    if(!config.deepseekApiKey)throw new ApiError(503,'PROVIDER_NOT_CONFIGURED','Memory and task services are available; this deployment has no model provider configured');
    const who=req.edgeIdentity!,input=modelInputSchema.parse(req.body),id=randomUUID();
    const controller=new AbortController();
    await transaction(db,async c=>{
      await c.query('SELECT pg_advisory_xact_lock(3180010)');
      const existing=(await c.query("SELECT device_id FROM model_requests WHERE state='submitted'")).rows;
      if(existing.length>=2||existing.some(r=>r.device_id===who.device_id))throw new ApiError(429,'MODEL_BUSY','模型请求正在处理，请等待原请求结果');
      const recent=Number((await c.query("SELECT count(*) AS n FROM model_requests WHERE device_id=$1 AND created_at>now()-interval '1 minute'",[who.device_id])).rows[0].n);
      if(recent>=30)throw new ApiError(429,'MODEL_RATE_LIMIT','设备模型调用过于频繁');
      await c.query("INSERT INTO model_requests(id,credential_id,device_id,model,state) VALUES($1,$2,$3,$4,'submitted')",[id,who.id,who.device_id,MODEL]);
    });
    active.set(id,controller);
    const timer=setTimeout(()=>controller.abort(),120000);
    const close=()=>{if(!reply.raw.writableEnded)controller.abort();};reply.raw.on('close',close);
    let state='submission_unknown',errorCode:string|null=null,usage:any=null,persisted=false;
    const persist=async()=>{
      const count=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0?Number(n):null;
      await db.query('UPDATE model_requests SET state=$2,error_code=$3,prompt_tokens=$4,completion_tokens=$5,finished_at=now() WHERE id=$1',[id,state,errorCode,count(usage?.prompt_tokens),count(usage?.completion_tokens)]);
      persisted=true;
    };
    try {
      const body={...input,max_tokens:input.max_tokens??input.max_completion_tokens??4096};
      delete body.max_completion_tokens;
      const upstream=await fetch(config.deepseekBaseUrl.replace(/\/$/,'')+'/chat/completions',{
        method:'POST',headers:{Authorization:`Bearer ${config.deepseekApiKey}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal,
      });
      if(!upstream.ok) {
        await upstream.body?.cancel();state='rejected';errorCode=`PROVIDER_HTTP_${upstream.status}`;await persist();
        return reply.code(upstream.status).send({error:{message:'模型提供商拒绝本次请求',type:'upstream_error',code:errorCode},request_id:id});
      }
      if(!input.stream) {
        const result=await upstream.json() as any;usage=result.usage;state='completed';await persist();return reply.header('X-AnyLink-Request-Id',id).send(result);
      }
      if(!upstream.body)throw new Error('EMPTY_PROVIDER_STREAM');
      reply.hijack();reply.raw.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no','X-AnyLink-Request-Id':id});
      const reader=upstream.body.getReader(),decoder=new TextDecoder();let lines='',done=false;
      try {
        while(true) {
          const chunk=await reader.read();if(chunk.done)break;
          lines+=decoder.decode(chunk.value,{stream:true});
          let end:number;while((end=lines.indexOf('\n'))>=0){const line=lines.slice(0,end).trim();lines=lines.slice(end+1);if(line==='data: [DONE]')done=true;else if(line.startsWith('data: ')){try{const data=JSON.parse(line.slice(6));if(data.usage)usage=data.usage;}catch{}}}
          if(lines.length>1048576)throw new Error('PROVIDER_EVENT_TOO_LARGE');
          // Release inference admission before the harness sees DONE and starts its next tool round.
          if(done){state='completed';await persist();}
          if(!reply.raw.write(chunk.value))await new Promise<void>((resolve,reject)=>{
            const clean=()=>{reply.raw.off('drain',drain);reply.raw.off('close',closed);};
            const drain=()=>{clean();resolve();};const closed=()=>{clean();reject(new Error('CLIENT_DISCONNECTED'));};
            reply.raw.once('drain',drain);reply.raw.once('close',closed);
          });
          if(done){await reader.cancel().catch(()=>{});break;}
        }
      }finally{reader.releaseLock();}
      state=done?'completed':'submission_unknown';if(!done)errorCode='PROVIDER_STREAM_INTERRUPTED';if(!persisted)await persist();reply.raw.end();
    } catch {
      if(!persisted)state='submission_unknown';
      errorCode=controller.signal.aborted?'MODEL_INTERRUPTED':'MODEL_TRANSPORT_UNKNOWN';
      if(!reply.raw.headersSent&&!reply.raw.destroyed)reply.code(502).send({error:{message:'模型响应未确认；代理没有自动重发',type:'upstream_error',code:errorCode},request_id:id});
      else if(!reply.raw.destroyed)reply.raw.destroy();
    } finally {
      clearTimeout(timer);reply.raw.off('close',close);active.delete(id);
      if(!persisted)await persist().catch(()=>{});
    }
  });
  app.addHook('preClose',async()=>{for(const controller of active.values())controller.abort();});
}
