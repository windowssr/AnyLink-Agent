import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import os from 'node:os';
import path, { basename } from 'node:path';
import type { Readable } from 'node:stream';
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

function decodeHeaderFilename(raw: unknown): string {
  const s = String(raw ?? 'attachment.bin');
  try { return decodeURIComponent(s); } catch { return s; }
}

function sanitizeFilename(raw: unknown): string {
  const cleaned = basename(String(raw ?? 'attachment.bin').replaceAll('\\', '/')).replace(/[\x00-\x1f"<>|:*?]/g, '_').trim();
  return (cleaned || 'attachment.bin').slice(0, 200);
}

function sanitizeContentType(raw: unknown): string {
  const base = String(raw ?? 'application/octet-stream').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(base) ? base : 'application/octet-stream';
}

export function resolveArtifactDir(configured?: string): string {
  const dir = configured?.trim() || path.join(os.tmpdir(), 'anylink-artifacts');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function safeArtifactFile(dir: string, storagePath: string): string | null {
  const clean = basename(storagePath);
  if (!/^[0-9a-f-]{36}\.bin$/i.test(clean)) return null;
  return path.join(dir, clean);
}

export async function pruneExpiredArtifacts(db: Db, artifactDir?: string): Promise<number> {
  const res = await db.query('DELETE FROM edge_artifacts WHERE owner_id=$1 AND expires_at<=now() RETURNING storage_path', [OWNER_ID]);
  const dir = artifactDir?.trim() || path.join(os.tmpdir(), 'anylink-artifacts');
  for (const row of res.rows) {
    if (row.storage_path) {
      const file = safeArtifactFile(dir, String(row.storage_path));
      if (file) await unlink(file).catch(() => {});
    }
  }
  return res.rowCount ?? 0;
}

async function streamToDisk(stream: Readable, tmpPath: string, maxBytes: number, remainingQuota: number): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  const out = createWriteStream(tmpPath, { mode: 0o600 });
  let size = 0;
  try {
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      size += chunk.length;
      if (size > maxBytes) {
        throw new ApiError(413, 'ARTIFACT_TOO_LARGE', `Artifact exceeds limit of ${maxBytes} bytes`);
      }
      if (size > remainingQuota) {
        throw new ApiError(413, 'ARTIFACT_QUOTA_EXCEEDED', 'Artifact storage quota exceeded');
      }
      hash.update(chunk);
      if (!out.write(chunk)) {
        await new Promise<void>((resolve, reject) => {
          out.once('drain', resolve);
          out.once('error', reject);
        });
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve());
      out.once('error', reject);
    });
    return { size, sha256: hash.digest('hex') };
  } catch (err) {
    out.destroy();
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

function isReadableStream(v: unknown): v is Readable {
  return !!v && typeof v === 'object' && typeof (v as Readable).pipe === 'function' && typeof (v as Readable)[Symbol.asyncIterator] === 'function';
}

export function registerArtifacts(app: FastifyInstance, db: Db, config: Config) {
  const maxBytes = config.artifactMaxBytes ?? 200 * 1024 * 1024;
  const quotaBytes = config.artifactQuotaBytes ?? 2 * 1024 * 1024 * 1024;
  const defaultTtl = config.artifactDefaultTtlSeconds ?? 3600;
  const jsonMaxBytes = Math.min(maxBytes, 25 * 1024 * 1024);
  const artifactDir = resolveArtifactDir(config.artifactDir);

  void app.register(async scope => {
    // Stream ANY non-JSON payload directly to disk (O(1) RAM) instead of buffering in memory.
    scope.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

    scope.post('/edge/v1/artifacts', { bodyLimit: Math.ceil(jsonMaxBytes * 1.4) + 65536 }, async (req, reply) => {
      const me = req.edgeIdentity!;
      await pruneExpiredArtifacts(db, artifactDir);
      const used = Number((await db.query('SELECT COALESCE(SUM(size_bytes),0) AS total FROM edge_artifacts WHERE owner_id=$1 AND expires_at>now()', [OWNER_ID])).rows[0].total);
      const remainingQuota = quotaBytes - used;
      if (remainingQuota <= 0) {
        throw new ApiError(413, 'ARTIFACT_QUOTA_EXCEEDED', `Artifact storage quota (${quotaBytes} bytes) exceeded`);
      }

      const id = randomUUID();
      const storageName = `${id}.bin`;
      const tmpPath = path.join(artifactDir, `${id}.tmp`);
      const finalPath = path.join(artifactDir, storageName);

      let filename: string;
      let contentType: string;
      let taskId: string | null = null;
      let ttlSeconds = defaultTtl;
      let sizeBytes: number;
      let sha256: string;

      if (isReadableStream(req.body)) {
        filename = sanitizeFilename(req.headers['x-anylink-filename'] ? decodeHeaderFilename(req.headers['x-anylink-filename']) : 'attachment.bin');
        contentType = sanitizeContentType(req.headers['x-anylink-content-type'] ?? req.headers['content-type']);
        const rawTaskId = req.headers['x-anylink-task-id'];
        if (rawTaskId) taskId = uuidOpt.parse(String(rawTaskId)) ?? null;
        const rawTtl = req.headers['x-anylink-ttl'];
        if (rawTtl !== undefined) ttlSeconds = z.coerce.number().int().min(60).max(86400).parse(rawTtl);

        const declaredLen = req.headers['content-length'] ? Number(req.headers['content-length']) : 0;
        if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
          throw new ApiError(413, 'ARTIFACT_TOO_LARGE', `Artifact exceeds limit of ${maxBytes} bytes`);
        }
        if (Number.isFinite(declaredLen) && declaredLen > remainingQuota) {
          throw new ApiError(413, 'ARTIFACT_QUOTA_EXCEEDED', `Artifact storage quota (${quotaBytes} bytes) exceeded`);
        }

        if (taskId) {
          const exists = (await db.query('SELECT 1 FROM link_tasks WHERE id=$1 AND owner_id=$2', [taskId, OWNER_ID])).rowCount;
          if (!exists) throw new ApiError(404, 'TASK_NOT_FOUND', 'Referenced task does not exist');
        }

        const written = await streamToDisk(req.body, tmpPath, maxBytes, remainingQuota);
        sizeBytes = written.size;
        sha256 = written.sha256;
        await rename(tmpPath, finalPath);
      } else {
        const parsed = artifactJsonUploadSchema.parse(req.body);
        const data = Buffer.from(parsed.data_base64, 'base64');
        filename = sanitizeFilename(parsed.filename);
        contentType = sanitizeContentType(parsed.content_type);
        taskId = parsed.task_id ?? null;
        ttlSeconds = parsed.ttl_seconds ?? defaultTtl;
        if (data.length > maxBytes) {
          throw new ApiError(413, 'ARTIFACT_TOO_LARGE', `Artifact exceeds limit of ${maxBytes} bytes`);
        }
        if (data.length > remainingQuota) {
          throw new ApiError(413, 'ARTIFACT_QUOTA_EXCEEDED', `Artifact storage quota (${quotaBytes} bytes) exceeded`);
        }
        if (taskId) {
          const exists = (await db.query('SELECT 1 FROM link_tasks WHERE id=$1 AND owner_id=$2', [taskId, OWNER_ID])).rowCount;
          if (!exists) throw new ApiError(404, 'TASK_NOT_FOUND', 'Referenced task does not exist');
        }
        sizeBytes = data.length;
        sha256 = createHash('sha256').update(data).digest('hex');
        const out = createWriteStream(tmpPath, { mode: 0o600 });
        await new Promise<void>((resolve, reject) => {
          out.once('error', reject);
          out.end(data, () => resolve());
        });
        await rename(tmpPath, finalPath);
      }

      try {
        const row = (await db.query(
          `INSERT INTO edge_artifacts(id,owner_id,source_device_id,source_agent_id,task_id,filename,content_type,size_bytes,sha256,data,storage_path,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,now()+$11*interval '1 second')
           RETURNING id,source_device_id,source_agent_id,task_id,filename,content_type,size_bytes,sha256,created_at,expires_at`,
          [id, OWNER_ID, me.device_id, me.agent_id, taskId, filename, contentType, sizeBytes, sha256, storageName, ttlSeconds],
        )).rows[0];
        return reply.code(201).send({ ...row, size_bytes: Number(row.size_bytes) });
      } catch (err) {
        try { unlinkSync(finalPath); } catch {}
        throw err;
      }
    });

    scope.get('/edge/v1/artifacts/:id/meta', async req => {
      const { id } = idParams.parse(req.params);
      const row = (await db.query(
        `SELECT id,source_device_id,source_agent_id,task_id,filename,content_type,size_bytes,sha256,created_at,expires_at
         FROM edge_artifacts WHERE id=$1 AND owner_id=$2 AND expires_at>now()`,
        [id, OWNER_ID],
      )).rows[0];
      if (!row) throw new ApiError(404, 'ARTIFACT_NOT_FOUND', 'Artifact not found or expired');
      return { ...row, size_bytes: Number(row.size_bytes) };
    });

    scope.get('/edge/v1/artifacts/:id', async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const row = (await db.query(
        `SELECT id,filename,content_type,size_bytes,sha256,data,storage_path,expires_at
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

      if (row.storage_path) {
        const file = safeArtifactFile(artifactDir, String(row.storage_path));
        if (!file || !existsSync(file)) throw new ApiError(404, 'ARTIFACT_NOT_FOUND', 'Artifact file missing on disk');
        return reply.send(createReadStream(file));
      }
      return reply.send(row.data);
    });

    scope.delete('/edge/v1/artifacts/:id', async req => {
      const { id } = idParams.parse(req.params);
      const res = await db.query('DELETE FROM edge_artifacts WHERE id=$1 AND owner_id=$2 RETURNING id,storage_path', [id, OWNER_ID]);
      if (!res.rowCount) throw new ApiError(404, 'ARTIFACT_NOT_FOUND', 'Artifact not found');
      const sp = res.rows[0].storage_path;
      if (sp) {
        const file = safeArtifactFile(artifactDir, String(sp));
        if (file) await unlink(file).catch(() => {});
      }
      return { deleted: true, id };
    });
  });
}
