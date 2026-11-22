import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError, idempotent, type Db } from './db.js';
import { OWNER_ID } from './config.js';

export const capabilityName = z.string().regex(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/).max(100);
export const capabilitiesSchema = z.object({capabilities:z.array(z.object({name:capabilityName,description:z.string().max(500)}).strict()).max(32)}).strict()
  .refine(v=>new Set(v.capabilities.map(c=>c.name)).size===v.capabilities.length,'Duplicate capability');
const payloadSchema = z.record(z.string(),z.unknown()).refine(v=>Buffer.byteLength(JSON.stringify(v))<=65536,'Payload exceeds 64 KiB');
const capabilityJson=(name:string)=>JSON.stringify([{name}]);
const agentTarget=z.object({agent_id:z.uuid()}).strict();
const deviceTarget=z.object({device_id:z.uuid()}).strict();
export const taskCreateSchema = z.object({
  target:z.union([agentTarget,deviceTarget]).optional(),target_device_id:z.uuid().optional(),
  capability:capabilityName,input:payloadSchema,ttl_seconds:z.number().int().min(10).max(86400).default(1800),
}).strict().superRefine((v,c)=>{
  if(v.target&&v.target_device_id!==undefined)c.addIssue({code:'custom',message:'target and target_device_id are mutually exclusive'});
});
export const taskResultSchema = z.object({state:z.enum(['succeeded','failed','cancelled','unknown']),output:payloadSchema.optional(),error:z.object({code:z.string().min(1).max(80),message:z.string().max(1000)}).strict().optional()}).strict();
const idParams=z.object({id:z.uuid()});
const states=['queued','running','cancel_requested','succeeded','failed','cancelled','unknown','expired'] as const;
const finalStates=new Set(['succeeded','failed','cancelled','unknown','expired']);
export const taskSchema=z.object({
  id:z.uuid(),source_device_id:z.uuid(),source_agent_id:z.uuid(),target_agent_id:z.uuid().nullable(),claimed_by_agent_id:z.uuid().nullable(),target_device_id:z.uuid().nullable(),capability:capabilityName,input:z.record(z.string(),z.unknown()),
  state:z.enum(states),result:taskResultSchema.nullable(),created_at:z.string(),expires_at:z.string(),started_at:z.string().nullable(),finished_at:z.string().nullable(),
});
function present(row:any){
  const {owner_id:_,source_credential_id:__,...task}=row;
  // Expiry is a read projection until the next claim cleans up the queue.
  return {...task,state:task.state==='queued'&&new Date(task.expires_at).getTime()<=Date.now()?'expired':task.state};
}
export function registerLink(app:FastifyInstance,db:Db){
  const key=(req:FastifyRequest)=>z.string().min(1).max(160).parse(req.headers['idempotency-key']);
  const who=(req:FastifyRequest)=>req.edgeIdentity!;
  async function taskFor(req:FastifyRequest,claimerOnly=false){
    const {id}=idParams.parse(req.params);
    const row=(await db.query('SELECT * FROM link_tasks WHERE id=$1 AND owner_id=$2',[id,OWNER_ID])).rows[0];
    const me=who(req);
    const visible=claimerOnly?row?.claimed_by_agent_id===me.agent_id:[row?.source_agent_id,row?.target_agent_id,row?.claimed_by_agent_id].includes(me.agent_id);
    if(!row||!visible)throw new ApiError(404,'TASK_NOT_FOUND','Task does not exist for this agent');
    return row;
  }
  app.get('/edge/v1/link/protocol',async()=>({protocol:'anylink',version:'2.0',delivery:'at-most-once-claim',requeue:false,capabilities:['memory','model','tasks','directory','persona'],routing:['agent','device','capability']}));
  // Deprecated compatibility shim for clients that only understand devices.
  // last_seen_at is credential activity, never a promise that a worker is online.
  app.get('/edge/v1/link/peers',async req=>{
    const rows=(await db.query(`SELECT d.id,d.name,d.platform,a.capabilities,a.last_seen_at FROM devices d
      JOIN agents a ON a.device_id=d.id AND a.revoked_at IS NULL
      WHERE d.owner_id=$1 AND d.id<>$2 ORDER BY d.name,d.id`,[OWNER_ID,who(req).device_id])).rows;
    const items=new Map<string,any>();
    for(const row of rows){
      const item=items.get(row.id)??{id:row.id,name:row.name,platform:row.platform,capabilities:[],last_seen_at:null};
      const seen=new Set(item.capabilities.map((c:any)=>c.name));
      for(const c of row.capabilities)if(!seen.has(c.name)){seen.add(c.name);item.capabilities.push(c);}
      if(!item.last_seen_at||new Date(row.last_seen_at)>new Date(item.last_seen_at))item.last_seen_at=row.last_seen_at;
      items.set(row.id,item);
    }
    return {items:[...items.values()].filter(i=>i.capabilities.length>0)};
  });
  app.get('/edge/v1/link/directory',async req=>{
    const me=who(req);
    const rows=(await db.query(`SELECT d.id AS device_id,d.name AS device_name,d.platform,a.id AS agent_id,a.key,a.name AS agent_name,a.kind,a.capabilities,a.last_seen_at
      FROM devices d JOIN agents a ON a.device_id=d.id AND a.revoked_at IS NULL
      WHERE d.owner_id=$1 ORDER BY d.name,d.id,a.key`,[OWNER_ID])).rows;
    const items=new Map<string,any>();
    for(const row of rows){
      const item=items.get(row.device_id)??{device:{id:row.device_id,name:row.device_name,platform:row.platform},agents:[]};
      item.agents.push({id:row.agent_id,key:row.key,name:row.agent_name,kind:row.kind,capabilities:row.capabilities,last_seen_at:row.last_seen_at,online:!!row.last_seen_at&&Date.now()-new Date(row.last_seen_at).getTime()<60000,self:row.agent_id===me.agent_id});
      items.set(row.device_id,item);
    }
    return {items:[...items.values()]};
  });
  app.post('/edge/v1/link/capabilities',async req=>{
    const body=capabilitiesSchema.parse(req.body),me=who(req);
    return (await idempotent(db,`${me.agent_id}:link:capabilities`,key(req),body,async c=>{
      await c.query('UPDATE agents SET capabilities=$2,capabilities_updated_at=now() WHERE id=$1',[me.agent_id,JSON.stringify(body.capabilities)]);
      return {agent_id:me.agent_id,device_id:me.device_id,...body};
    })).value;
  });
  app.post('/edge/v1/link/tasks',async req=>{
    const body=taskCreateSchema.parse(req.body),me=who(req);
    return (await idempotent(db,`${me.agent_id}:link:create`,key(req),body,async c=>{
      let targetAgentId:string|null=null,targetDeviceId:string|null=null;
      const cap=capabilityJson(body.capability);
      if(body.target&&'agent_id' in body.target){
        const agent=(await c.query('SELECT id,device_id FROM agents WHERE id=$1 AND revoked_at IS NULL AND capabilities @> $2::jsonb',[body.target.agent_id,cap])).rows[0];
        if(!agent)throw new ApiError(409,'NO_TARGET_AGENT','No live agent advertises this capability for the requested target');
        targetAgentId=agent.id;targetDeviceId=agent.device_id;
      }else{
        const deviceId=body.target&&'device_id' in body.target?body.target.device_id:body.target_device_id??null;
        if(deviceId){
          if(!(await c.query('SELECT 1 FROM devices WHERE id=$1 AND owner_id=$2',[deviceId,OWNER_ID])).rowCount)throw new ApiError(409,'NO_TARGET_AGENT','Target device does not exist');
          if(!(await c.query('SELECT 1 FROM agents WHERE device_id=$1 AND revoked_at IS NULL AND capabilities @> $2::jsonb LIMIT 1',[deviceId,cap])).rowCount)throw new ApiError(409,'NO_TARGET_AGENT','No live agent on the target device advertises this capability');
          targetDeviceId=deviceId;
        }else if(!(await c.query('SELECT 1 FROM agents WHERE owner_id=$1 AND revoked_at IS NULL AND capabilities @> $2::jsonb LIMIT 1',[OWNER_ID,cap])).rowCount)throw new ApiError(409,'NO_TARGET_AGENT','No live agent advertises this capability');
      }
      const row=(await c.query(`INSERT INTO link_tasks(id,owner_id,source_device_id,source_agent_id,target_device_id,target_agent_id,capability,input,expires_at,source_credential_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+$9*interval '1 second',$10) RETURNING *`,[randomUUID(),OWNER_ID,me.device_id,me.agent_id,targetDeviceId,targetAgentId,body.capability,JSON.stringify(body.input),body.ttl_seconds,me.id])).rows[0];
      return present(row);
    })).value;
  });
  app.get('/edge/v1/link/tasks',async req=>{
    const query=z.object({role:z.enum(['source','target']).default('source'),state:z.enum(states).optional()}).strict().parse(req.query);
    const me=who(req);
    const rows=(await db.query(`SELECT * FROM link_tasks WHERE owner_id=$1 AND (($2='source' AND source_agent_id=$3) OR ($2='target' AND (claimed_by_agent_id=$3 OR target_agent_id=$3)))
      AND ($4::text IS NULL OR CASE WHEN state='queued' AND expires_at<=now() THEN 'expired' ELSE state END=$4)
      ORDER BY created_at DESC LIMIT 100`,[OWNER_ID,query.role,me.agent_id,query.state??null])).rows.map(present);
    return {items:rows};
  });
  app.get('/edge/v1/link/tasks/:id',async req=>present(await taskFor(req)));
  app.post('/edge/v1/link/tasks/claim',async req=>{
    z.object({}).strict().parse(req.body??{});const me=who(req);
    return (await idempotent(db,`${me.agent_id}:link:claim`,key(req),{},async c=>{
      const routable=`(target_agent_id=$1 OR (target_agent_id IS NULL AND target_device_id=$2) OR (target_agent_id IS NULL AND target_device_id IS NULL))`;
      await c.query(`UPDATE link_tasks SET state='expired',finished_at=now() WHERE state='queued' AND expires_at<=now() AND ${routable}`,[me.agent_id,me.device_id]);
      // Claim once; process crashes never silently requeue executable work.
      const row=(await c.query(`SELECT t.* FROM link_tasks t
        JOIN agents sa ON sa.id=t.source_agent_id AND sa.revoked_at IS NULL
        JOIN agents me ON me.id=$1
        WHERE t.state='queued' AND t.expires_at>now() AND me.capabilities @> jsonb_build_array(jsonb_build_object('name',t.capability))
        AND (t.target_agent_id=$1 OR (t.target_agent_id IS NULL AND t.target_device_id=$2) OR (t.target_agent_id IS NULL AND t.target_device_id IS NULL))
        ORDER BY CASE WHEN t.target_agent_id IS NOT NULL THEN 0 WHEN t.target_device_id IS NOT NULL THEN 1 ELSE 2 END,t.created_at,t.id FOR UPDATE OF t SKIP LOCKED LIMIT 1`,[me.agent_id,me.device_id])).rows[0];
      if(!row)return {task:null};
      return {task:present((await c.query("UPDATE link_tasks SET state='running',started_at=now(),claimed_by_agent_id=$2 WHERE id=$1 RETURNING *",[row.id,me.agent_id])).rows[0])};
    },{cacheResult:value=>value.task!==null})).value;
  });
  app.post('/edge/v1/link/tasks/:id/result',async req=>{
    const row=await taskFor(req,true),body=taskResultSchema.parse(req.body);
    return (await idempotent(db,`${who(req).agent_id}:link:result:${row.id}`,key(req),body,async c=>{
      const current=(await c.query('SELECT * FROM link_tasks WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
      if(finalStates.has(current.state))throw new ApiError(409,'TASK_TERMINAL','Task already has a terminal result');
      if(!['running','cancel_requested'].includes(current.state))throw new ApiError(409,'TASK_NOT_CLAIMED','Claim the task before reporting a result');
      return present((await c.query('UPDATE link_tasks SET state=$2,result=$3,finished_at=now() WHERE id=$1 RETURNING *',[row.id,body.state,JSON.stringify(body)])).rows[0]);
    })).value;
  });
  app.post('/edge/v1/link/tasks/:id/cancel',async req=>{
    const row=await taskFor(req);if(row.source_agent_id!==who(req).agent_id)throw new ApiError(403,'TASK_SOURCE_REQUIRED','Only the source agent can cancel a task');
    z.object({}).strict().parse(req.body??{});
    return (await idempotent(db,`${who(req).agent_id}:link:cancel:${row.id}`,key(req),{},async c=>{
      return present((await c.query(`UPDATE link_tasks SET state=CASE WHEN state='queued' AND expires_at<=now() THEN 'expired' WHEN state='queued' THEN 'cancelled' WHEN state='running' THEN 'cancel_requested' ELSE state END,
        finished_at=CASE WHEN state='queued' THEN now() ELSE finished_at END WHERE id=$1 RETURNING *`,[row.id])).rows[0]);
    })).value;
  });
}
