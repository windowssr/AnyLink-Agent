import pg, { type PoolClient } from 'pg';
import { createHash } from 'node:crypto';
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export type Db = pg.Pool;
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function createDb(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 7, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
}
export async function transaction<T>(db: Db, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}
export async function idempotent<T>(db: Db, scope: string, key: string, body: unknown, fn: (c: PoolClient) => Promise<T>): Promise<{ value: T; replayed: boolean }> {
  if (!key || key.length > 160) throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '写操作需要 Idempotency-Key');
  const digest = hash(canonical(body));
  return transaction(db, async c => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${scope}:${key}`]);
    const old = (await c.query('SELECT body_hash,result FROM mutation_keys WHERE scope=$1 AND key=$2', [scope,key])).rows[0];
    if (old) {
      if (old.body_hash !== digest) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同内容');
      return { value: old.result as T, replayed: true };
    }
    const value = await fn(c);
    await c.query('INSERT INTO mutation_keys(scope,key,body_hash,result) VALUES($1,$2,$3,$4)', [scope,key,digest,JSON.stringify(value)]);
    return { value, replayed: false };
  });
}
const schema = `
CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS auth_sessions(token_hash text PRIMARY KEY,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS mutation_keys(scope text NOT NULL,key text NOT NULL,body_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(scope,key));
CREATE TABLE IF NOT EXISTS devices(id uuid PRIMARY KEY,owner_id uuid NOT NULL,name text NOT NULL,platform text NOT NULL CHECK(platform IN ('macos','android','other')),revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS conversations(id uuid PRIMARY KEY,owner_id uuid NOT NULL,title text NOT NULL,session_key text NOT NULL UNIQUE,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS requests(id uuid PRIMARY KEY,owner_id uuid NOT NULL,conversation_id uuid NOT NULL REFERENCES conversations(id),body_hash text NOT NULL,message text NOT NULL,origin_device_id uuid REFERENCES devices(id),target_device_id uuid REFERENCES devices(id),allow_memory_write boolean NOT NULL DEFAULT false,state text NOT NULL CHECK(state IN ('queued','submitted','responding','completed','submission_unknown','failed')),response_text text NOT NULL DEFAULT '',error_code text,tool_rounds integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS requests_conversation ON requests(conversation_id,created_at);
CREATE TABLE IF NOT EXISTS memories(id uuid PRIMARY KEY,owner_id uuid NOT NULL,title text NOT NULL,content text NOT NULL,scope text NOT NULL CHECK(scope IN ('global','device')),applicable_device_id uuid REFERENCES devices(id),source_device_id uuid REFERENCES devices(id),source_request_id uuid REFERENCES requests(id),source_kind text NOT NULL,revision integer NOT NULL DEFAULT 1,deleted boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),CHECK((scope='global' AND applicable_device_id IS NULL) OR (scope='device' AND applicable_device_id IS NOT NULL)));
CREATE INDEX IF NOT EXISTS memories_active_scope ON memories(owner_id,scope,applicable_device_id) WHERE NOT deleted;
CREATE TABLE IF NOT EXISTS memory_revisions(memory_id uuid NOT NULL REFERENCES memories(id),revision integer NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(memory_id,revision));
CREATE TABLE IF NOT EXISTS tasks(id uuid PRIMARY KEY,owner_id uuid NOT NULL,goal text NOT NULL,origin_device_id uuid REFERENCES devices(id),target_device_id uuid NOT NULL REFERENCES devices(id),conversation_id uuid REFERENCES conversations(id),source_request_id uuid REFERENCES requests(id),status text NOT NULL DEFAULT 'waiting_device' CHECK(status IN ('waiting_device','cancelled')),revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
`;
export async function migrate(db: Db) {
  await transaction(db, async c => { await c.query('SELECT pg_advisory_xact_lock(3180001)'); await c.query(schema); });
}
