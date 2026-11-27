import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError, type Db } from './db.js';
import { type Config, OWNER_ID } from './config.js';

const idParams = z.object({ id: z.uuid() });
const uuidOpt = z.uuid().optional();

export const artifactJsonUploadSchema = z.object({
  filename: z.string().trim().min(1).max(200).default('attachment.bin'),
  content_type: z.string().trim().min(1).max(160).default('application/octet-stream'),
  data_base64: z.string().min(1),
  task_id: z.uuid().optional(),
  ttl_seconds: z.number().int().min(60).max(86400).optional(),
}).strict();

export const artifactMetaSchema = z.object({
  id: z.uuid(),
  source_device_id: z.uuid(),
  source_agent_id: z.uuid(),
  task_id: z.uuid().nullable(),
  filename: z.string(),
  content_type: z.string(),
  size_bytes: z.number().int(),
  sha256: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
});

function sanitizeFilename(raw: unknown): string {
  const cleaned = basename(String(raw ?? 'attachment.bin').replaceAll('\\', '/')).replace(/[\x00-\x1f"<>|:*?]/g, '_').trim();
  return (cleaned || 'attachment.bin').slice(0, 200);
}

function sanitizeContentType(raw: unknown): string {
  const base = String(raw ?? 'application/octet-stream').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(base) ? base : 'application/octet-stream';
}

export async function pruneExpiredArtifacts(db: Db): Promise<number> {
  const res = await db.query('DELETE FROM edge_artifacts WHERE owner_id=$1 AND expires_at<=now()', [OWNER_ID]);
  return res.rowCount ?? 0;
}

export function registerArtifacts(app: FastifyInstance, db: Db, config: Config) {
  const maxBytes = config.artifactMaxBytes ?? 10 * 1024 * 1024;
  const quotaBytes = config.artifactQuotaBytes ?? 200 * 1024 * 1024;
  const defaultTtl = config.artifactDefaultTtlSeconds ?? 3600;

  void app.register(async scope => {
    // Allow raw binary payloads on /edge/v1/artifacts without altering JSON parsing elsewhere.
    const binaryParser = (_req: unknown, body: Buffer, done: (err: Error | null, res?: Buffer) => void) => done(null, body);
    for (const mime of ['application/octet-stream', 'application/pdf', 'text/plain', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'audio/mpeg', 'audio/wav', 'audio/ogg']) {
      scope.addContentTypeParser(mime, { parseAs: 'buffer', bodyLimit: maxBytes + 1024 }, binaryParser);
    }

    scope.post('/edge/v1/artifacts', { bodyLimit: Math.ceil(maxBytes * 1.4) + 65536 }, async (req, reply) => {
      const me = req.edgeIdentity!;
      let data: Buffer;
      let filename: string;
      let contentType: string;
      let taskId: string | null = null;
      let ttlSeconds = defaultTtl;

      if (Buffer.isBuffer(req.body)) {
        data = req.body;
        filename = sanitizeFilename(req.headers['x-anylink-filename'] ? decodeURIComponent(String(req.headers['x-anylink-filename'])) : 'attachment.bin');
        contentType = sanitizeContentType(req.headers['x-anylink-content-type'] ?? req.headers['content-type']);
        const rawTaskId = req.headers['x-anylink-task-id'];
        if (rawTaskId) taskId = uuidOpt.parse(String(rawTaskId)) ?? null;
        const rawTtl = req.headers['x-anylink-ttl'];
        if (rawTtl !== undefined) ttlSeconds = z.coerce.number().int().min(60).max(86400).parse(rawTtl);
      } else {
        const parsed = artifactJsonUploadSchema.parse(req.body);
        data = Buffer.from(parsed.data_base64, 'base64');
        filename = sanitizeFilename(parsed.filename);
        contentType = sanitizeContentType(parsed.content_type);
        taskId = parsed.task_id ?? null;
        ttlSeconds = parsed.ttl_seconds ?? defaultTtl;
      }

      if (data.length > maxBytes) {
        throw new ApiError(413, 'ARTIFACT_TOO_LARGE', `Artifact exceeds limit of ${maxBytes} bytes`);
      }

      await pruneExpiredArtifacts(db);
      const used = Number((await db.query('SELECT COALESCE(SUM(size_bytes),0) AS total FROM edge_artifacts WHERE owner_id=$1 AND expires_at>now()', [OWNER_ID])).rows[0].total);
      if (used + data.length > quotaBytes) {
        throw new ApiError(413, 'ARTIFACT_QUOTA_EXCEEDED', `Artifact storage quota (${quotaBytes} bytes) exceeded`);
      }

      if (taskId) {
        const exists = (await db.query('SELECT 1 FROM link_tasks WHERE id=$1 AND owner_id=$2', [taskId, OWNER_ID])).rowCount;
        if (!exists) throw new ApiError(404, 'TASK_NOT_FOUND', 'Referenced task does not exist');
      }

      const id = randomUUID();
      const sha256 = createHash('sha256').update(data).digest('hex');
      const row = (await db.query(
        `INSERT INTO edge_artifacts(id,owner_id,source_device_id,source_agent_id,task_id,filename,content_type,size_bytes,sha256,data,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+$11*interval '1 second')
         RETURNING id,source_device_id,source_agent_id,task_id,filename,content_type,size_bytes,sha256,created_at,expires_at`,
        [id, OWNER_ID, me.device_id, me.agent_id, taskId, filename, contentType, data.length, sha256, data, ttlSeconds],
      )).rows[0];
      return reply.code(201).send(row);
    });

    scope.get('/edge/v1/artifacts/:id/meta', async req => {
      const { id } = idParams.parse(req.params);
      const row = (await db.query(
        `SELECT id,source_device_id,source_agent_id,task_id,filename,content_type,size_bytes,sha256,created_at,expires_at
         FROM edge_artifacts WHERE id=$1 AND owner_id=$2 AND expires_at>now()`,
        [id, OWNER_ID],
      )).rows[0];
      if (!row) throw new ApiError(404, 'ARTIFACT_NOT_FOUND', 'Artifact not found or expired');
      return row;
    });

    scope.get('/edge/v1/artifacts/:id', async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const row = (await db.query(
        `SELECT id,filename,content_type,size_bytes,sha256,data,expires_at
         FROM edge_artifacts WHERE id=$1 AND owner_id=$2 AND expires_at>now()`,
        [id, OWNER_ID],
      )).rows[0];
      if (!row) throw new ApiError(404, 'ARTIFACT_NOT_FOUND', 'Artifact not found or expired');
      const safeName = encodeURIComponent(row.filename);
      reply
        .header('Content-Type', row.content_type)
        .header('Content-Length', String(row.size_bytes))
        .header('ETag', `"${row.sha256}"`)
        .header('X-AnyLink-SHA256', row.sha256)
        .header('X-AnyLink-Filename', safeName)
        .header('Content-Disposition', `attachment; filename*=UTF-8''${safeName}`);
      return reply.send(row.data);
    });

    scope.delete('/edge/v1/artifacts/:id', async req => {
      const { id } = idParams.parse(req.params);
      const res = await db.query('DELETE FROM edge_artifacts WHERE id=$1 AND owner_id=$2 RETURNING id', [id, OWNER_ID]);
      if (!res.rowCount) throw new ApiError(404, 'ARTIFACT_NOT_FOUND', 'Artifact not found');
      return { deleted: true, id };
    });
  });
}
