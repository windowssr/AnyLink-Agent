import Fastify, { type FastifyRequest } from 'fastify';
import staticPlugin from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { type Config, OWNER_ID } from './config.js';
import { ApiError, createDb, hash, idempotent, migrate } from './db.js';
import { createDevice, deleteMemory, deviceSchema, editMemory, getMemory, listDevices, memoryDirectory, memoryPatchSchema, memorySchema, saveMemory, searchMemories } from './store.js';
import { authenticateEdge,registerCredentialRoutes } from './edge-auth.js';
import { registerModelProxy } from './model-proxy.js';

const idParams=z.object({id:z.uuid()});
const tokenFromCookie=(r:FastifyRequest)=>(r.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith('anylink_session='))?.slice('anylink_session='.length);
export async function createApp(config:Config,{logger=true}:{logger?:boolean}={}) {
  const app=Fastify({logger:logger?{level:'info',redact:['req.headers.authorization','req.headers.cookie','res.headers["set-cookie"]'],serializers:{req:r=>({method:r.method,url:r.url?.split('?')[0]}),err:e=>({type:e.name,code:e.code,message:'Details redacted',stack:''})}}:false,bodyLimit:2097152,forceCloseConnections:true,disableRequestLogging:true});
  const db=createDb(config.databaseUrl);await migrate(db);
  const loginAttempts=new Map<string,{count:number;until:number}>();
  app.addHook('onRequest',async(req,reply)=>{
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('Cache-Control','no-store');
    reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(['POST','PATCH','PUT','DELETE'].includes(req.method)&&req.headers.origin&&req.headers.origin!==config.origin)throw new ApiError(403,'ORIGIN_REJECTED','不接受其他网站发起的写请求');
    const path=req.url.split('?')[0];
    if(path.startsWith('/edge/v1/')||path.startsWith('/model/v1/')){await authenticateEdge(db,req);return;}
    if(!path.startsWith('/v1/')||path==='/v1/auth/login')return;
    const token=tokenFromCookie(req);
    if(!token||token.length>200)throw new ApiError(401,'AUTH_REQUIRED','请先登录');
    if(!(await db.query('SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND expires_at>now()',[hash(token)])).rowCount)throw new ApiError(401,'AUTH_REQUIRED','会话已过期，请重新登录');
  });
  app.setErrorHandler((error,req,reply)=>{
    if(error instanceof ApiError)return reply.code(error.status).send({error:{code:error.code,message:error.message},request_id:req.id});
    if(error instanceof z.ZodError)return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')},request_id:req.id});
    const status=(error as {statusCode?:number}).statusCode;
    if(status&&status>=400&&status<500)return reply.code(status).send({error:{code:'INVALID_REQUEST',message:'请求格式不正确'},request_id:req.id});
    app.log.error({code:(error as {code?:string}).code,requestId:req.id},'Request failed');
    return reply.code(500).send({error:{code:'INTERNAL_ERROR',message:'请求暂时无法完成'},request_id:req.id});
  });
  const key=(r:FastifyRequest)=>z.string().min(1).max(160).parse(r.headers['idempotency-key']);
  async function mutate(req:FastifyRequest,scope:string,body:unknown,fn:Parameters<typeof idempotent>[4]) {
    return (await idempotent(db,scope,key(req),body,fn)).value;
  }
  app.get('/healthz',async()=>({ok:true,service:'anylink-agent',version:'0.2.0',role:'memory-and-model-services'}));
  app.get('/readyz',async(_req,reply)=>{
    let database=false;try{await db.query('SELECT 1');database=true;}catch{}
    const provider_configured=!!config.deepseekApiKey;
    return reply.code(database&&provider_configured?200:503).send({ok:database&&provider_configured,database,provider_configured,cloud_agent:false});
  });
  app.post('/v1/auth/login',async(req,reply)=>{
    const input=z.object({token:z.string().min(1).max(200)}).strict().parse(req.body),now=Date.now(),old=loginAttempts.get(req.ip);
    if(old&&old.until>now&&old.count>=5)throw new ApiError(429,'LOGIN_RATE_LIMIT','尝试过于频繁，请 15 分钟后再试');
    if(!timingSafeEqual(Buffer.from(hash(input.token)),Buffer.from(hash(config.ownerToken)))){
      loginAttempts.set(req.ip,{count:old&&old.until>now?old.count+1:1,until:old&&old.until>now?old.until:now+900000});throw new ApiError(401,'INVALID_TOKEN','登录令牌不正确');
    }
    loginAttempts.delete(req.ip);const token=randomBytes(32).toString('base64url');
    await db.query('DELETE FROM auth_sessions WHERE expires_at<=now()');
    await db.query("INSERT INTO auth_sessions(token_hash,expires_at) VALUES($1,now()+interval '7 days')",[hash(token)]);
    reply.header('Set-Cookie',`anylink_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${config.origin.startsWith('https:')?'; Secure':''}`);return {ok:true};
  });
  app.post('/v1/auth/logout',async(req,reply)=>{
    await db.query('DELETE FROM auth_sessions WHERE token_hash=$1',[hash(tokenFromCookie(req)??'')]);reply.header('Set-Cookie','anylink_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');return {ok:true};
  });
  app.get('/v1/status',async()=>({version:'0.2.0',assistant:'AnyLink',model:'deepseek-flash',cloud_agent:false,execution_enabled:false,owner_id:OWNER_ID}));
  app.get('/v1/devices',async()=>({items:(await db.query(`SELECT d.*,c.id AS credential_id,c.created_at AS bound_at,c.last_used_at FROM devices d LEFT JOIN edge_credentials c ON c.device_id=d.id AND c.revoked_at IS NULL WHERE d.owner_id=$1 ORDER BY d.created_at`,[OWNER_ID])).rows}));
  app.post('/v1/devices',async req=>{const v=deviceSchema.parse(req.body);return mutate(req,'devices:create',v,c=>createDevice(c,v));});
  registerCredentialRoutes(app,db);registerModelProxy(app,db,config);
  app.get('/edge/v1/identity',async req=>({device:(await listDevices(db)).find(d=>d.id===req.edgeIdentity!.device_id),scopes:['memory','model']}));
  app.get('/edge/v1/context',async req=>{
    const [global,device]=await Promise.all([searchMemories(db,{scope:'global',limit:30}),searchMemories(db,{device_id:req.edgeIdentity!.device_id,limit:30})]);
    return {device_id:req.edgeIdentity!.device_id,global,device,directory:{device_id:req.edgeIdentity!.device_id,entries:device.map(m=>({id:m.id,title:m.title,revision:m.revision}))}};
  });
  for(const prefix of ['/v1','/edge/v1']) {
    const source=(req:FastifyRequest)=>({kind:req.edgeIdentity?'edge_owner_statement':'owner_edit',deviceId:req.edgeIdentity?.device_id});
    const scope=(req:FastifyRequest,op:string)=>`${req.edgeIdentity?.id??'owner'}:${op}`;
    app.get(prefix+'/devices/:id/memory-directory',async req=>memoryDirectory(db,idParams.parse(req.params).id));
    const searchSchema=z.object({q:z.string().max(200).optional(),scope:z.enum(['global','device']).optional(),device_id:z.uuid().optional()}).strict();
    app.get(prefix+'/memories',async req=>({items:await searchMemories(db,searchSchema.parse(req.query))}));
    app.post(prefix+'/memories/search',async req=>({items:await searchMemories(db,searchSchema.parse(req.body))}));
    app.get(prefix+'/memories/:id',async req=>getMemory(db,idParams.parse(req.params).id));
    app.get(prefix+'/memories/:id/revisions',async req=>{const {id}=idParams.parse(req.params);await getMemory(db,id);return {items:(await db.query('SELECT revision,snapshot,created_at FROM memory_revisions WHERE memory_id=$1 ORDER BY revision DESC',[id])).rows};});
    app.post(prefix+'/memories',async req=>{const v=memorySchema.parse(req.body);return mutate(req,scope(req,'memories:create'),v,c=>saveMemory(c,v,source(req)));});
    app.patch(prefix+'/memories/:id',async req=>{const {id}=idParams.parse(req.params),v=memoryPatchSchema.parse(req.body);return mutate(req,scope(req,`memories:edit:${id}`),v,c=>editMemory(c,id,v,source(req)));});
    app.delete(prefix+'/memories/:id',async req=>{const {id}=idParams.parse(req.params),revision=z.coerce.number().int().positive().parse(String(req.headers['if-match']??'').replaceAll('"',''));return mutate(req,scope(req,`memories:delete:${id}`),{revision},c=>deleteMemory(c,id,revision));});
  }
  app.get('/v1/model-requests',async()=>({items:(await db.query('SELECT id,device_id,model,state,prompt_tokens,completion_tokens,error_code,created_at,finished_at FROM model_requests ORDER BY created_at DESC LIMIT 50')).rows}));
  // Keep historical records, but no cloud sessions, tool loop or runnable task endpoint.
  for(const path of ['/v1/conversations','/v1/conversations/*','/v1/requests/*','/v1/tasks','/v1/tasks/*'])app.all(path,async(_req,reply)=>reply.code(410).send({error:{code:'EDGE_AGENT_REQUIRED',message:'请在 Mac 本地 OpenClaw 交互；云端只提供记忆和模型服务'}}));
  const webRoot=resolve('dist/web');if(existsSync(webRoot))await app.register(staticPlugin,{root:webRoot,prefix:'/',index:['index.html']});
  app.setNotFoundHandler((_req,reply)=>reply.code(404).send({error:{code:'NOT_FOUND',message:'接口或页面不存在'}}));
  app.addHook('onClose',async()=>{await db.end();});return {app,db};
}
