import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError, idempotent, type Db } from './db.js';
import { OWNER_ID } from './config.js';
import { requireDevice } from './store.js';

export const capabilityName = z.string().regex(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/).max(100);
export const capabilitiesSchema = z.object({capabilities:z.array(z.object({name:capabilityName,description:z.string().max(500)}).strict()).max(32)}).strict()
  .refine(v=>new Set(v.capabilities.map(c=>c.name)).size===v.capabilities.length,'Duplicate capability');
const payloadSchema = z.record(z.string(),z.unknown()).refine(v=>Buffer.byteLength(JSON.stringify(v))<=65536,'Payload exceeds 64 KiB');
export const taskCreateSchema = z.object({target_device_id:z.uuid(),capability:capabilityName,input:payloadSchema,ttl_seconds:z.number().int().min(10).max(86400).default(1800)}).strict();
export const taskResultSchema = z.object({state:z.enum(['succeeded','failed','cancelled','unknown']),output:payloadSchema.optional(),error:z.object({code:z.string().min(1).max(80),message:z.string().max(1000)}).strict().optional()}).strict();
export const grantSchema = z.object({source_device_id:z.uuid(),target_device_id:z.uuid(),capability:capabilityName,enabled:z.boolean()}).strict();
const idParams=z.object({id:z.uuid()});
const states=['queued','running','cancel_requested','succeeded','failed','cancelled','unknown','expired'] as const;
const finalStates=new Set(['succeeded','failed','cancelled','unknown','expired']);
export const taskSchema=z.object({
  id:z.uuid(),source_device_id:z.uuid(),target_device_id:z.uuid(),capability:capabilityName,input:z.record(z.string(),z.unknown()),
  state:z.enum(states),result:taskResultSchema.nullable(),created_at:z.string(),expires_at:z.string(),started_at:z.string().nullable(),finished_at:z.string().nullable(),
});
function present(row:any){
  const {owner_id:_,source_credential_id:__,...task}=row;
  // Expiry is a read projection until the next claim cleans up the queue.
  return {...task,state:task.state==='queued'&&new Date(task.expires_at).getTime()<=Date.now()?'expired':task.state};
}
export function registerLink(app:FastifyInstance,db:Db){
  const key=(req:FastifyRequest)=>z.string().min(1).max(160).parse(req.headers['idempotency-key']);
  const who=(req:FastifyRequest)=>req.edgeIdentity!.device_id;
  async function taskFor(req:FastifyRequest,executorOnly=false){
    const {id}=idParams.parse(req.params);
    const row=(await db.query('SELECT * FROM link_tasks WHERE id=$1 AND owner_id=$2',[id,OWNER_ID])).rows[0];
    if(!row||!(executorOnly?row.target_device_id===who(req):[row.source_device_id,row.target_device_id].includes(who(req))))throw new ApiError(404,'TASK_NOT_FOUND','Task does not exist for this device');
    return row;
  }
  app.get('/edge/v1/link/protocol',async()=>({protocol:'anylink',version:'1.0',delivery:'at-most-once-claim',requeue:false,capabilities:['memory','model','tasks']}));
  // Discovery exposes only capabilities explicitly granted to this source.
  // last_seen_at is credential activity, never a promise that a worker is online.
  app.get('/edge/v1/link/peers',async req=>({items:(await db.query(`SELECT d.id,d.name,d.platform,a.capabilities,
    array_agg(DISTINCT g.capability) AS granted_capabilities,max(e.last_used_at) AS last_seen_at
    FROM link_grants g JOIN devices d ON d.id=g.target_device_id
    JOIN link_capabilities a ON a.device_id=d.id
    JOIN edge_credentials e ON e.device_id=d.id AND e.revoked_at IS NULL
    WHERE g.source_device_id=$1 AND g.enabled
    GROUP BY d.id,a.capabilities ORDER BY d.name,d.id`,[who(req)])).rows.map(row=>({...row,
      capabilities:row.capabilities.filter((c:{name:string})=>row.granted_capabilities.includes(c.name)),
    }))}));
  app.post('/v1/link/grants',async req=>{
    const body=grantSchema.parse(req.body);
    return (await idempotent(db,'owner:link:grant',key(req),body,async c=>{
      await requireDevice(c,body.source_device_id);await requireDevice(c,body.target_device_id);
      return (await c.query(`INSERT INTO link_grants(source_device_id,target_device_id,capability,enabled) VALUES($1,$2,$3,$4)
        ON CONFLICT(source_device_id,target_device_id,capability) DO UPDATE SET enabled=EXCLUDED.enabled RETURNING *`,[body.source_device_id,body.target_device_id,body.capability,body.enabled])).rows[0];
    })).value;
  });
  app.get('/v1/link/grants',async()=>({items:(await db.query('SELECT * FROM link_grants ORDER BY source_device_id,target_device_id,capability')).rows}));
  app.post('/edge/v1/link/capabilities',async req=>{
    const body=capabilitiesSchema.parse(req.body),id=who(req);
    return (await idempotent(db,`${id}:link:capabilities`,key(req),body,async c=>{
      await c.query(`INSERT INTO link_capabilities(device_id,capabilities) VALUES($1,$2) ON CONFLICT(device_id) DO UPDATE SET capabilities=EXCLUDED.capabilities,updated_at=now()`,[id,JSON.stringify(body.capabilities)]);
      return {device_id:id,...body};
    })).value;
  });
  app.post('/edge/v1/link/tasks',async req=>{
    const body=taskCreateSchema.parse(req.body),source=who(req);
    return (await idempotent(db,`${source}:link:create`,key(req),body,async c=>{
      const allowed=await c.query(`SELECT 1 FROM link_grants g JOIN link_capabilities a ON a.device_id=g.target_device_id
        JOIN edge_credentials e ON e.device_id=g.target_device_id AND e.revoked_at IS NULL
        WHERE g.source_device_id=$1 AND g.target_device_id=$2 AND g.capability=$3 AND g.enabled
        AND a.capabilities @> $4::jsonb`,[source,body.target_device_id,body.capability,JSON.stringify([{name:body.capability}])]);
      if(!allowed.rowCount)throw new ApiError(403,'CAPABILITY_NOT_GRANTED','Owner grant and target capability registration are required');
      const row=(await c.query(`INSERT INTO link_tasks(id,owner_id,source_device_id,target_device_id,capability,input,expires_at,source_credential_id)
        VALUES($1,$2,$3,$4,$5,$6,now()+$7*interval '1 second',$8) RETURNING *`,[randomUUID(),OWNER_ID,source,body.target_device_id,body.capability,JSON.stringify(body.input),body.ttl_seconds,req.edgeIdentity!.id])).rows[0];
      return present(row);
    })).value;
  });
  app.get('/edge/v1/link/tasks',async req=>{
    const query=z.object({role:z.enum(['source','target']).default('source'),state:z.enum(states).optional()}).strict().parse(req.query);
    const column=query.role==='source'?'source_device_id':'target_device_id';
    const rows=(await db.query(`SELECT * FROM link_tasks WHERE ${column}=$1 AND owner_id=$2
      AND ($3::text IS NULL OR CASE WHEN state='queued' AND expires_at<=now() THEN 'expired' ELSE state END=$3)
      ORDER BY created_at DESC LIMIT 100`,[who(req),OWNER_ID,query.state??null])).rows.map(present);
    return {items:rows};
  });
  app.get('/edge/v1/link/tasks/:id',async req=>present(await taskFor(req)));
  app.post('/edge/v1/link/tasks/claim',async req=>{
    z.object({}).strict().parse(req.body??{});const target=who(req);
    return (await idempotent(db,`${target}:link:claim`,key(req),{},async c=>{
      await c.query("UPDATE link_tasks SET state='expired',finished_at=now() WHERE target_device_id=$1 AND state='queued' AND expires_at<=now()",[target]);
      // Claim once; process crashes never silently requeue executable work.
      const row=(await c.query(`SELECT t.* FROM link_tasks t
        JOIN link_grants g ON g.source_device_id=t.source_device_id AND g.target_device_id=t.target_device_id AND g.capability=t.capability AND g.enabled
        JOIN link_capabilities a ON a.device_id=t.target_device_id
        JOIN edge_credentials e ON e.id=t.source_credential_id AND e.device_id=t.source_device_id AND e.revoked_at IS NULL
        WHERE t.target_device_id=$1 AND t.state='queued' AND t.expires_at>now() AND a.capabilities @> jsonb_build_array(jsonb_build_object('name',t.capability))
        ORDER BY t.created_at,t.id FOR UPDATE OF t SKIP LOCKED LIMIT 1`,[target])).rows[0];
      if(!row)return {task:null};
      return {task:present((await c.query("UPDATE link_tasks SET state='running',started_at=now() WHERE id=$1 RETURNING *",[row.id])).rows[0])};
    },{cacheResult:value=>value.task!==null})).value;
  });
  app.post('/edge/v1/link/tasks/:id/result',async req=>{
    const row=await taskFor(req,true),body=taskResultSchema.parse(req.body);
    return (await idempotent(db,`${who(req)}:link:result:${row.id}`,key(req),body,async c=>{
      const current=(await c.query('SELECT * FROM link_tasks WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
      if(finalStates.has(current.state))throw new ApiError(409,'TASK_TERMINAL','Task already has a terminal result');
      if(!['running','cancel_requested'].includes(current.state))throw new ApiError(409,'TASK_NOT_CLAIMED','Claim the task before reporting a result');
      return present((await c.query('UPDATE link_tasks SET state=$2,result=$3,finished_at=now() WHERE id=$1 RETURNING *',[row.id,body.state,JSON.stringify(body)])).rows[0]);
    })).value;
  });
  app.post('/edge/v1/link/tasks/:id/cancel',async req=>{
    const row=await taskFor(req);if(row.source_device_id!==who(req))throw new ApiError(403,'TASK_SOURCE_REQUIRED','Only the source device can cancel a task');
    z.object({}).strict().parse(req.body??{});
    return (await idempotent(db,`${who(req)}:link:cancel:${row.id}`,key(req),{},async c=>{
      return present((await c.query(`UPDATE link_tasks SET state=CASE WHEN state='queued' AND expires_at<=now() THEN 'expired' WHEN state='queued' THEN 'cancelled' WHEN state='running' THEN 'cancel_requested' ELSE state END,
        finished_at=CASE WHEN state='queued' THEN now() ELSE finished_at END WHERE id=$1 RETURNING *`,[row.id])).rows[0]);
    })).value;
  });
}
