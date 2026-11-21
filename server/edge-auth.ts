import { randomBytes,randomUUID } from 'node:crypto';
import type { FastifyInstance,FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError,hash,type Db,transaction } from './db.js';
import { OWNER_ID } from './config.js';
export type EdgeIdentity={id:string;device_id:string};
declare module 'fastify' {interface FastifyRequest {edgeIdentity?:EdgeIdentity}}
export async function authenticateEdge(db:Db,req:FastifyRequest) {
  const token=(req.headers.authorization??'').replace(/^Bearer /,'');
  if(!token.startsWith('ak_')||token.length>150)throw new ApiError(401,'EDGE_AUTH_REQUIRED','需要设备服务凭据');
  const row=(await db.query('UPDATE edge_credentials SET last_used_at=now() WHERE token_hash=$1 AND revoked_at IS NULL RETURNING id,device_id',[hash(token)])).rows[0];
  if(!row)throw new ApiError(401,'EDGE_AUTH_REQUIRED','设备凭据无效或已撤销');
  req.edgeIdentity=row;return row as EdgeIdentity;
}
export function registerCredentialRoutes(app:FastifyInstance,db:Db) {
  app.post('/v1/devices/:id/credential',async(req,reply)=>{
    const {id}=z.object({id:z.uuid()}).parse(req.params);
    const result=await transaction(db,async c=>{
      if(!(await c.query('SELECT id FROM devices WHERE id=$1 AND owner_id=$2 FOR UPDATE',[id,OWNER_ID])).rowCount)throw new ApiError(404,'DEVICE_NOT_FOUND','设备不存在');
      if((await c.query('SELECT 1 FROM edge_credentials WHERE device_id=$1 AND revoked_at IS NULL',[id])).rowCount)throw new ApiError(409,'DEVICE_ALREADY_BOUND','请先撤销旧凭据');
      const token='ak_'+randomBytes(32).toString('base64url'),credentialId=randomUUID();
      await c.query('INSERT INTO edge_credentials(id,device_id,token_hash) VALUES($1,$2,$3)',[credentialId,id,hash(token)]);
      return {credential_id:credentialId,device_id:id,token};
    });
    // One-time secret issuance is deliberately not cached as an idempotency result.
    reply.code(201);return result;
  });
  app.post('/v1/devices/:id/revoke',async req=>{
    const {id}=z.object({id:z.uuid()}).parse(req.params);
    if(!(await db.query('SELECT id FROM devices WHERE id=$1 AND owner_id=$2',[id,OWNER_ID])).rowCount)throw new ApiError(404,'DEVICE_NOT_FOUND','设备不存在');
    await db.query('UPDATE edge_credentials SET revoked_at=now() WHERE device_id=$1 AND revoked_at IS NULL',[id]);
    return {device_id:id,revoked:true};
  });
}
