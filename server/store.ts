import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApiError } from './db.js';
import { OWNER_ID } from './config.js';
export type Queryable = Pick<PoolClient, 'query'>;
export const deviceSchema = z.object({ name: z.string().trim().min(1).max(80), platform: z.enum(['macos','android','other']) }).strict();
export const memorySearchSchema=z.object({q:z.string().max(200).optional(),scope:z.enum(['global','device','agent']).optional(),device_id:z.uuid().optional()}).strict();
export const memorySchema = z.object({
  title: z.string().trim().min(1).max(120), content: z.string().trim().min(1).max(4000),
  scope: z.enum(['global','device','agent']), applicable_device_id: z.uuid().nullable().optional(), applicable_agent_id: z.uuid().nullable().optional(),
}).strict().superRefine((v,c) => {
  if (v.scope === 'global' && (v.applicable_device_id || v.applicable_agent_id)) c.addIssue({code:'custom',message:'全局记忆不能绑定适用设备或 Agent'});
  if (v.scope === 'device' && (!v.applicable_device_id || v.applicable_agent_id)) c.addIssue({code:'custom',message:'设备记忆必须选择适用设备，且不能绑定 Agent'});
  if (v.scope === 'agent' && v.applicable_device_id) c.addIssue({code:'custom',message:'Agent 记忆的适用设备由 Agent 推导，不能指定'});
});
export const memoryPatchSchema = z.object({ title: z.string().trim().min(1).max(120).optional(), content: z.string().trim().min(1).max(4000).optional(), expected_revision: z.number().int().positive() }).strict().refine(v => v.title !== undefined || v.content !== undefined, '至少修改一个字段');
export type Source = { deviceId?: string | null; agentId?: string | null; requestId?: string | null; kind: string };
export type Viewer = { agentId?: string | null };
export async function requireDevice(db: Queryable, id?: string | null) {
  if (!id) return;
  if (!(await db.query('SELECT id FROM devices WHERE id=$1 AND owner_id=$2', [id,OWNER_ID])).rowCount) throw new ApiError(404,'DEVICE_NOT_FOUND','设备不存在');
}
export async function requireAgent(db: Queryable, id?: string | null) {
  if (!id) return null;
  const row=(await db.query('SELECT id,device_id,key,name,kind,capabilities FROM agents WHERE id=$1 AND owner_id=$2',[id,OWNER_ID])).rows[0];
  if (!row) throw new ApiError(404,'AGENT_NOT_FOUND','Agent 不存在');
  return row;
}
export async function requireConversation(db: Queryable, id: string) {
  const row = (await db.query('SELECT * FROM conversations WHERE id=$1 AND owner_id=$2',[id,OWNER_ID])).rows[0];
  if (!row) throw new ApiError(404,'CONVERSATION_NOT_FOUND','会话不存在');
  return row;
}
export async function createDevice(db: Queryable, input: z.infer<typeof deviceSchema>) {
  return (await db.query('INSERT INTO devices(id,owner_id,name,platform) VALUES($1,$2,$3,$4) RETURNING *,false AS executor_connected', [randomUUID(),OWNER_ID,input.name,input.platform])).rows[0];
}
export async function listDevices(db: Queryable) {
  return (await db.query('SELECT *,false AS executor_connected FROM devices WHERE owner_id=$1 ORDER BY created_at,id',[OWNER_ID])).rows;
}
export async function searchMemories(db: Queryable, input: { q?: string; scope?: string; device_id?: string; limit?: number; context?: boolean; viewer?: Viewer }) {
  if (input.device_id) await requireDevice(db,input.device_id);
  return (await db.query(`SELECT m.*,d.name AS device_name FROM memories m LEFT JOIN devices d ON d.id=m.applicable_device_id
    WHERE m.owner_id=$1 AND NOT m.deleted
    AND ($2='' OR position(lower($2) in lower(m.title || ' ' || m.content))>0)
    AND ($3='' OR m.scope=$3)
    AND ($4::uuid IS NULL OR m.applicable_device_id=$4 OR ($5 AND m.scope='global'))
    AND ($7::uuid IS NULL OR m.scope<>'agent' OR m.applicable_agent_id=$7)
    ORDER BY m.updated_at DESC,m.id LIMIT $6`,[OWNER_ID,input.q ?? '',input.scope ?? '',input.device_id ?? null,input.context ?? false,Math.min(input.limit ?? 100,100),input.viewer?.agentId ?? null])).rows;
}
export async function saveMemory(db: Queryable, input: z.infer<typeof memorySchema>, source: Source) {
  let applicableDeviceId=input.applicable_device_id??null,applicableAgentId=input.applicable_agent_id??null;
  if(input.scope==='agent'){
    const agent=await requireAgent(db,applicableAgentId);
    if(!agent)throw new ApiError(400,'AGENT_REQUIRED','Agent 记忆必须指定适用 Agent');
    applicableDeviceId=agent.device_id;
  }
  await requireDevice(db,applicableDeviceId); await requireDevice(db,source.deviceId);
  const existing = (await db.query(`SELECT * FROM memories WHERE owner_id=$1 AND NOT deleted AND scope=$2 AND applicable_device_id IS NOT DISTINCT FROM $3::uuid AND applicable_agent_id IS NOT DISTINCT FROM $4::uuid AND title=$5 AND content=$6 LIMIT 1`,[OWNER_ID,input.scope,applicableDeviceId,applicableAgentId,input.title,input.content])).rows[0];
  if (existing) return existing;
  const row = (await db.query(`INSERT INTO memories(id,owner_id,title,content,scope,applicable_device_id,applicable_agent_id,source_device_id,source_agent_id,source_request_id,source_kind)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[randomUUID(),OWNER_ID,input.title,input.content,input.scope,applicableDeviceId,applicableAgentId,source.deviceId ?? null,source.agentId ?? null,source.requestId ?? null,source.kind])).rows[0];
  await db.query('INSERT INTO memory_revisions(memory_id,revision,snapshot) VALUES($1,$2,$3)',[row.id,row.revision,JSON.stringify(row)]);
  return row;
}
export async function getMemory(db: Queryable, id: string, viewer?: Viewer) {
  const row=(await db.query(`SELECT m.*,d.name AS device_name FROM memories m LEFT JOIN devices d ON d.id=m.applicable_device_id WHERE m.id=$1 AND m.owner_id=$2 AND NOT m.deleted AND ($3::uuid IS NULL OR m.scope<>'agent' OR m.applicable_agent_id=$3)`,[id,OWNER_ID,viewer?.agentId ?? null])).rows[0];
  if (!row) throw new ApiError(404,'MEMORY_NOT_FOUND','记忆不存在或已删除');
  return row;
}
export async function editMemory(db: Queryable, id: string, input: z.infer<typeof memoryPatchSchema>, source: Source, viewer?: Viewer) {
  const row=(await db.query(`UPDATE memories SET title=COALESCE($1,title),content=COALESCE($2,content),revision=revision+1,updated_at=now(),source_device_id=$3,source_agent_id=COALESCE($10,source_agent_id),source_request_id=$4,source_kind=$5
    WHERE id=$6 AND owner_id=$7 AND NOT deleted AND revision=$8 AND ($9::uuid IS NULL OR scope<>'agent' OR applicable_agent_id=$9) RETURNING *`,[input.title ?? null,input.content ?? null,source.deviceId ?? null,source.requestId ?? null,source.kind,id,OWNER_ID,input.expected_revision,viewer?.agentId ?? null,source.agentId ?? null])).rows[0];
  if (!row) { await getMemory(db,id,viewer); throw new ApiError(409,'REVISION_CONFLICT','记忆已被修改，请刷新后重试'); }
  await db.query('INSERT INTO memory_revisions(memory_id,revision,snapshot) VALUES($1,$2,$3)',[id,row.revision,JSON.stringify(row)]);
  return row;
}
export async function deleteMemory(db: Queryable, id: string, revision: number, viewer?: Viewer) {
  const row=(await db.query(`UPDATE memories SET deleted=true,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2 AND revision=$3 AND NOT deleted AND ($4::uuid IS NULL OR scope<>'agent' OR applicable_agent_id=$4) RETURNING *`,[id,OWNER_ID,revision,viewer?.agentId ?? null])).rows[0];
  if (!row) { await getMemory(db,id,viewer); throw new ApiError(409,'REVISION_CONFLICT','记忆已被修改，请刷新后重试'); }
  await db.query('INSERT INTO memory_revisions(memory_id,revision,snapshot) VALUES($1,$2,$3)',[id,row.revision,JSON.stringify(row)]);
  return { id,revision:row.revision,deleted:true };
}
export async function memoryDirectory(db: Queryable, id: string) {
  await requireDevice(db,id);
  const facts=await searchMemories(db,{device_id:id,scope:'device'});
  return { device_id:id,executor_connected:false,source:'current_active_facts',entries:facts.map(m=>({id:m.id,title:m.title,revision:m.revision,updated_at:m.updated_at})) };
}
