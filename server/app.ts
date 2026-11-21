import Fastify, { type FastifyRequest } from 'fastify';
import staticPlugin from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { type Config, OWNER_ID } from './config.js';
import { ApiError, createDb, hash, idempotent, migrate } from './db.js';
import { ChatService, messageSchema } from './chat.js';
import { cancelTask, createDevice, createTask, deleteMemory, deviceSchema, editMemory, getMemory, getTask, listDevices, listTasks, memoryDirectory, memoryPatchSchema, memorySchema, requireConversation, saveMemory, searchMemories, taskSchema } from './store.js';

const idParams=z.object({id:z.uuid()});
const tokenFromCookie=(r:FastifyRequest)=>(r.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith('anylink_session='))?.slice('anylink_session='.length);
const terminal=(state:string)=>['completed','submission_unknown','failed'].includes(state);
export async function createApp(config:Config,{logger=true,leadership=true}:{logger?:boolean;leadership?:boolean}={}) {
  const app=Fastify({logger:logger?{level:'info',redact:['req.headers.authorization','req.headers.cookie','res.headers["set-cookie"]'],serializers:{req:r=>({method:r.method,url:r.url?.split('?')[0]}),err:e=>({type:e.name,code:e.code,message:'Details redacted; use request code',stack:''})}}:false,bodyLimit:32768,forceCloseConnections:true,disableRequestLogging:true});
  const db=createDb(config.databaseUrl);await migrate(db);
  const leader=leadership?await db.connect():null;
  if(leader) {
    if(!(await leader.query('SELECT pg_try_advisory_lock(3180003) AS locked')).rows[0].locked) {leader.release();await db.end();throw new Error('Another AnyLink instance owns the run admission lock');}
    await db.query("UPDATE requests SET state='submission_unknown',error_code='SERVICE_RESTARTED',updated_at=now() WHERE state IN ('queued','submitted','responding')");
    leader.on('error',()=>{app.log.error('Database leadership connection lost; closing service');void app.close();});
  }
  const chat=new ChatService(db,config);
  const loginAttempts=new Map<string,{count:number;until:number}>();
  app.addHook('onRequest',async(req,reply)=>{
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('Cache-Control','no-store');
    reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(['POST','PATCH','PUT','DELETE'].includes(req.method)&&req.headers.origin&&req.headers.origin!==config.origin) throw new ApiError(403,'ORIGIN_REJECTED','不接受其他网站发起的写请求');
    const path=req.url.split('?')[0];
    if(!path.startsWith('/v1/')||path==='/v1/auth/login') return;
    const token=tokenFromCookie(req);
    if(!token||token.length>200) throw new ApiError(401,'AUTH_REQUIRED','请先登录');
    const valid=(await db.query('SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND expires_at>now()',[hash(token)])).rowCount;
    if(!valid) throw new ApiError(401,'AUTH_REQUIRED','会话已过期，请重新登录');
  });
  app.setErrorHandler((error,req,reply)=>{
    if(error instanceof ApiError) return reply.code(error.status).send({error:{code:error.code,message:error.message},request_id:req.id});
    if(error instanceof z.ZodError) return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')},request_id:req.id});
    const status=(error as {statusCode?:number}).statusCode;
    if(status&&status>=400&&status<500) return reply.code(status).send({error:{code:'INVALID_REQUEST',message:'请求格式不正确'},request_id:req.id});
    app.log.error({code:(error as {code?:string}).code,requestId:req.id},'Request failed');
    return reply.code(500).send({error:{code:'INTERNAL_ERROR',message:'请求暂时无法完成，请保留请求编号'},request_id:req.id});
  });
  const key=(r:FastifyRequest)=>z.string().min(1).max(160).parse(r.headers['idempotency-key']);
  async function mutate(req:FastifyRequest,scope:string,body:unknown,fn:Parameters<typeof idempotent>[4]) {
    return (await idempotent(db,scope,key(req),body,fn)).value;
  }
  app.get('/healthz',async()=>({ok:true,service:'anylink-agent',version:'0.1.0'}));
  app.get('/readyz',async(_req,reply)=>{
    let database=false,gateway=false;
    try{await db.query('SELECT 1');database=true;}catch{}
    try{const r=await fetch(`${config.gatewayUrl}/v1/models`,{headers:{Authorization:`Bearer ${config.gatewayToken}`},signal:AbortSignal.timeout(3000)});gateway=r.ok;await r.body?.cancel();}catch{}
    return reply.code(database&&gateway?200:503).send({ok:database&&gateway,database,gateway});
  });
  app.post('/v1/auth/login',async(req,reply)=>{
    const input=z.object({token:z.string().min(1).max(200)}).strict().parse(req.body);
    const old=loginAttempts.get(req.ip);const now=Date.now();
    if(old&&old.until>now&&old.count>=5) throw new ApiError(429,'LOGIN_RATE_LIMIT','尝试过于频繁，请 15 分钟后再试');
    if(!timingSafeEqual(Buffer.from(hash(input.token)),Buffer.from(hash(config.ownerToken)))) {
      loginAttempts.set(req.ip,{count:old&&old.until>now?old.count+1:1,until:old&&old.until>now?old.until:now+900000});
      throw new ApiError(401,'INVALID_TOKEN','登录令牌不正确');
    }
    loginAttempts.delete(req.ip);
    const token=randomBytes(32).toString('base64url');
    await db.query("DELETE FROM auth_sessions WHERE expires_at<=now()");
    await db.query("INSERT INTO auth_sessions(token_hash,expires_at) VALUES($1,now()+interval '7 days')",[hash(token)]);
    reply.header('Set-Cookie',`anylink_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${config.origin.startsWith('https:')?'; Secure':''}`);
    return {ok:true};
  });
  app.post('/v1/auth/logout',async(req,reply)=>{
    await db.query('DELETE FROM auth_sessions WHERE token_hash=$1',[hash(tokenFromCookie(req)??'')]);
    reply.header('Set-Cookie','anylink_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');return {ok:true};
  });
  app.get('/v1/status',async()=>({version:'0.1.0',assistant:'AnyLink',model:'deepseek/deepseek-flash',execution_enabled:false,device_identity:'declared_logical_device',memory_search:'structured_and_substring',owner_id:OWNER_ID}));
  app.get('/v1/devices',async()=>({items:await listDevices(db)}));
  app.post('/v1/devices',async req=>{const v=deviceSchema.parse(req.body);return mutate(req,'devices:create',v,c=>createDevice(c,v));});
  app.get('/v1/devices/:id/memory-directory',async req=>memoryDirectory(db,idParams.parse(req.params).id));
  app.get('/v1/memories',async req=>{
    const q=z.object({q:z.string().max(200).optional(),scope:z.enum(['global','device']).optional(),device_id:z.uuid().optional()}).parse(req.query);
    return {items:await searchMemories(db,q)};
  });
  app.post('/v1/memories/search',async req=>{const v=z.object({q:z.string().max(200).optional(),scope:z.enum(['global','device']).optional(),device_id:z.uuid().optional()}).strict().parse(req.body);return {items:await searchMemories(db,v)};});
  app.get('/v1/memories/:id',async req=>getMemory(db,idParams.parse(req.params).id));
  app.get('/v1/memories/:id/revisions',async req=>{const {id}=idParams.parse(req.params);await getMemory(db,id);return {items:(await db.query('SELECT revision,snapshot,created_at FROM memory_revisions WHERE memory_id=$1 ORDER BY revision DESC',[id])).rows};});
  app.post('/v1/memories',async req=>{const v=memorySchema.parse(req.body);return mutate(req,'memories:create',v,c=>saveMemory(c,v,{kind:'owner_edit'}));});
  app.patch('/v1/memories/:id',async req=>{const {id}=idParams.parse(req.params),v=memoryPatchSchema.parse(req.body);return mutate(req,`memories:edit:${id}`,v,c=>editMemory(c,id,v,{kind:'owner_edit'}));});
  app.delete('/v1/memories/:id',async req=>{
    const {id}=idParams.parse(req.params);const revision=z.coerce.number().int().positive().parse(String(req.headers['if-match']??'').replaceAll('"',''));
    return mutate(req,`memories:delete:${id}`,{revision},c=>deleteMemory(c,id,revision));
  });
  app.get('/v1/tasks',async()=>({items:await listTasks(db)}));
  app.get('/v1/tasks/:id',async req=>getTask(db,idParams.parse(req.params).id));
  app.post('/v1/tasks',async req=>{const v=taskSchema.parse(req.body);return mutate(req,'tasks:create',v,c=>createTask(c,v,{kind:'owner_request',deviceId:v.origin_device_id}));});
  app.post('/v1/tasks/:id/cancel',async req=>{const {id}=idParams.parse(req.params);return mutate(req,`tasks:cancel:${id}`,{},c=>cancelTask(c,id));});
  app.get('/v1/conversations',async()=>({items:(await db.query(`SELECT c.*,(SELECT max(r.created_at) FROM requests r WHERE r.conversation_id=c.id) AS last_message_at FROM conversations c WHERE owner_id=$1 ORDER BY COALESCE((SELECT max(r.created_at) FROM requests r WHERE r.conversation_id=c.id),c.created_at) DESC LIMIT 100`,[OWNER_ID])).rows}));
  app.post('/v1/conversations',async req=>{
    const v=z.object({title:z.string().trim().min(1).max(120).default('新的对话')}).strict().parse(req.body??{});
    return mutate(req,'conversations:create',v,async c=>{const id=randomUUID();return (await c.query('INSERT INTO conversations(id,owner_id,title,session_key) VALUES($1,$2,$3,$4) RETURNING *',[id,OWNER_ID,v.title,`anylink:conversation:${id}`])).rows[0];});
  });
  app.get('/v1/conversations/:id',async req=>{
    const {id}=idParams.parse(req.params);const conv=await requireConversation(db,id);
    return {...conv,requests:(await db.query('SELECT id,message,state,response_text,error_code,tool_rounds,origin_device_id,target_device_id,created_at FROM requests WHERE conversation_id=$1 AND owner_id=$2 ORDER BY created_at,id',[id,OWNER_ID])).rows,history_source:'gateway_response_projection'};
  });
  app.post('/v1/conversations/:id/messages',async(req,reply)=>{
    const {id}=idParams.parse(req.params),v=messageSchema.parse(req.body);
    if(key(req)!==v.request_id) throw new ApiError(400,'REQUEST_KEY_MISMATCH','消息的幂等键必须与 request_id 一致');
    const {row,replayed}=await chat.accept(id,v);reply.code(replayed?200:202);
    return {request_id:row.id,state:row.state,replayed,events_url:`/v1/requests/${row.id}/events`};
  });
  app.get('/v1/requests/:id',async req=>chat.get(idParams.parse(req.params).id));
  app.get('/v1/requests/:id/events',async(req,reply)=>{
    const {id}=idParams.parse(req.params);await chat.get(id);
    reply.hijack();const raw=reply.raw;
    raw.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
    let initialized=false;let seq=-1;const pending:any[]=[];
    const send=(event:any)=>{
      if(!initialized) {pending.push(event);return;}
      if(raw.destroyed||raw.writableEnded||event.seq<=seq) return;
      seq=event.seq;raw.write(`data: ${JSON.stringify(event)}\n\n`);
      if(event.type==='final') raw.end();
    };
    chat.events.on(id,send);
    const timer=setInterval(()=>{if(!raw.destroyed&&!raw.writableEnded) raw.write(': heartbeat\n\n');},15000);
    raw.on('close',()=>{clearInterval(timer);chat.events.off(id,send);});
    try {
      const snapshot=await chat.get(id);seq=snapshot.stream_seq??0;
      raw.write(`data: ${JSON.stringify({type:'snapshot',...snapshot})}\n\n`);initialized=true;
      if(terminal(snapshot.state)) raw.end();else for(const event of pending) send(event);
    } catch {raw.end();}
  });
  const webRoot=resolve('dist/web');
  if(existsSync(webRoot)) {
    await app.register(staticPlugin,{root:webRoot,prefix:'/',index:['index.html']});
    app.setNotFoundHandler((req,reply)=>req.url.startsWith('/v1/')?reply.code(404).send({error:{code:'NOT_FOUND',message:'接口不存在'}}):reply.code(404).send({error:{code:'NOT_FOUND',message:'页面不存在'}}));
  }
  app.addHook('preClose',async()=>{await chat.close();});
  app.addHook('onClose',async()=>{if(leader){await leader.query('SELECT pg_advisory_unlock(3180003)').catch(()=>{});leader.release();}await db.end();});
  return {app,db,chat};
}
