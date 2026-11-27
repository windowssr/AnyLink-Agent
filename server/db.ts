import pg, { type PoolClient } from 'pg';
import { createHash } from 'node:crypto';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export type Db = pg.Pool;
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function createDb(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
}

export async function transaction<T>(db: Db, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}

export async function idempotent<T>(db: Db, scope: string, key: string, body: unknown, fn: (c: PoolClient) => Promise<T>, options: { cacheResult?: (value: T) => boolean } = {}): Promise<{ value: T; replayed: boolean }> {
  if (!key || key.length > 160) throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Write operations require Idempotency-Key');
  const digest = hash(canonical(body));
  return transaction(db, async c => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${scope}:${key}`]);
    const old = (await c.query('SELECT body_hash,result FROM mutation_keys WHERE scope=$1 AND key=$2', [scope, key])).rows[0];
    if (old) {
      if (old.body_hash !== digest) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key cannot be reused with different content');
      return { value: old.result as T, replayed: true };
    }
    const value = await fn(c);
    if (options.cacheResult?.(value) !== false) await c.query('INSERT INTO mutation_keys(scope,key,body_hash,result) VALUES($1,$2,$3,$4)', [scope, key, digest, JSON.stringify(value)]);
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
  await transaction(db, async c => {
    await c.query('SELECT pg_advisory_xact_lock(3180001)');
    await c.query(schema);
    if (!(await c.query('SELECT 1 FROM schema_migrations WHERE version=2')).rowCount) {
      await c.query(`CREATE TABLE IF NOT EXISTS edge_credentials(
        id uuid PRIMARY KEY,device_id uuid NOT NULL REFERENCES devices(id),token_hash text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),last_used_at timestamptz,revoked_at timestamptz);
        CREATE UNIQUE INDEX IF NOT EXISTS one_edge_credential ON edge_credentials(device_id) WHERE revoked_at IS NULL;
        CREATE TABLE IF NOT EXISTS model_requests(
        id uuid PRIMARY KEY,credential_id uuid NOT NULL REFERENCES edge_credentials(id),device_id uuid NOT NULL REFERENCES devices(id),
        model text NOT NULL,state text NOT NULL CHECK(state IN ('submitted','completed','rejected','submission_unknown','cancelled')),
        prompt_tokens integer,completion_tokens integer,error_code text,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz);
        CREATE INDEX IF NOT EXISTS model_device_recent ON model_requests(device_id,created_at);
        INSERT INTO schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;`);
    }
    if (!(await c.query('SELECT 1 FROM schema_migrations WHERE version=3')).rowCount) {
      await c.query(`CREATE TABLE IF NOT EXISTS link_capabilities(device_id uuid PRIMARY KEY REFERENCES devices(id),capabilities jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS link_grants(source_device_id uuid NOT NULL REFERENCES devices(id),target_device_id uuid NOT NULL REFERENCES devices(id),capability text NOT NULL,enabled boolean NOT NULL DEFAULT false,PRIMARY KEY(source_device_id,target_device_id,capability));
        CREATE TABLE IF NOT EXISTS link_tasks(id uuid PRIMARY KEY,owner_id uuid NOT NULL,source_device_id uuid NOT NULL REFERENCES devices(id),source_credential_id uuid NOT NULL REFERENCES edge_credentials(id),target_device_id uuid NOT NULL REFERENCES devices(id),capability text NOT NULL,input jsonb NOT NULL,
        state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','cancel_requested','succeeded','failed','cancelled','unknown','expired')),result jsonb,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,started_at timestamptz,finished_at timestamptz);
        CREATE INDEX IF NOT EXISTS link_task_queue ON link_tasks(target_device_id,created_at) WHERE state='queued';
        CREATE INDEX IF NOT EXISTS link_task_source ON link_tasks(source_device_id,created_at);
        INSERT INTO schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;`);
    }
    if (!(await c.query('SELECT 1 FROM schema_migrations WHERE version=4')).rowCount) {
      await c.query(`ALTER TABLE devices ADD COLUMN install_id text;
        ALTER TABLE devices ADD COLUMN revoked_at timestamptz;
        ALTER TABLE devices ADD CONSTRAINT devices_install_id_key UNIQUE(install_id);
        CREATE TABLE agents(id uuid PRIMARY KEY,owner_id uuid NOT NULL,device_id uuid NOT NULL REFERENCES devices(id),key text NOT NULL,name text NOT NULL,kind text NOT NULL DEFAULT 'agent',capabilities jsonb NOT NULL DEFAULT '[]',capabilities_updated_at timestamptz,last_seen_at timestamptz,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(device_id,key));
        INSERT INTO agents(id,owner_id,device_id,key,name,kind) SELECT gen_random_uuid(),owner_id,id,'default',name,'legacy' FROM devices d WHERE NOT EXISTS(SELECT 1 FROM agents a WHERE a.device_id=d.id);
        UPDATE agents a SET capabilities=lc.capabilities,capabilities_updated_at=lc.updated_at FROM link_capabilities lc WHERE lc.device_id=a.device_id AND a.key='default';
        DROP TABLE link_capabilities;DROP TABLE link_grants;
        ALTER TABLE edge_credentials ADD COLUMN agent_id uuid REFERENCES agents(id);
        UPDATE edge_credentials e SET agent_id=a.id FROM agents a WHERE a.device_id=e.device_id AND a.key='default' AND e.agent_id IS NULL;
        ALTER TABLE edge_credentials ALTER COLUMN agent_id SET NOT NULL;
        DROP INDEX one_edge_credential;
        CREATE UNIQUE INDEX one_agent_credential ON edge_credentials(agent_id) WHERE revoked_at IS NULL;
        ALTER TABLE link_tasks ADD COLUMN source_agent_id uuid REFERENCES agents(id);
        ALTER TABLE link_tasks ADD COLUMN target_agent_id uuid REFERENCES agents(id);
        ALTER TABLE link_tasks ADD COLUMN claimed_by_agent_id uuid REFERENCES agents(id);
        UPDATE link_tasks t SET source_agent_id=e.agent_id FROM edge_credentials e WHERE e.id=t.source_credential_id AND t.source_agent_id IS NULL;
        ALTER TABLE link_tasks ALTER COLUMN source_agent_id SET NOT NULL;
        UPDATE link_tasks t SET claimed_by_agent_id=a.id FROM agents a WHERE a.device_id=t.target_device_id AND a.key='default' AND t.state<>'queued' AND t.claimed_by_agent_id IS NULL;
        ALTER TABLE link_tasks ALTER COLUMN target_device_id DROP NOT NULL;
        DROP INDEX link_task_queue;DROP INDEX link_task_source;
        CREATE INDEX link_task_agent_queue ON link_tasks(target_agent_id,created_at) WHERE state='queued';
        CREATE INDEX link_task_device_queue ON link_tasks(target_device_id,capability,created_at) WHERE state='queued';
        CREATE INDEX link_task_any_queue ON link_tasks(capability,created_at) WHERE state='queued' AND target_agent_id IS NULL AND target_device_id IS NULL;
        CREATE INDEX link_task_source_agent ON link_tasks(source_agent_id,created_at);
        ALTER TABLE memories ADD COLUMN applicable_agent_id uuid REFERENCES agents(id);
        ALTER TABLE memories ADD COLUMN source_agent_id uuid REFERENCES agents(id);
        DO $$ DECLARE r record; BEGIN FOR r IN SELECT conname FROM pg_constraint WHERE conrelid='memories'::regclass AND contype='c' LOOP EXECUTE format('ALTER TABLE memories DROP CONSTRAINT %I',r.conname); END LOOP; END $$;
        ALTER TABLE memories ADD CONSTRAINT memories_scope_check CHECK(scope IN ('global','device','agent'));
        ALTER TABLE memories ADD CONSTRAINT memories_scope_applicability CHECK((scope='global' AND applicable_device_id IS NULL AND applicable_agent_id IS NULL) OR (scope='device' AND applicable_device_id IS NOT NULL AND applicable_agent_id IS NULL) OR (scope='agent' AND applicable_agent_id IS NOT NULL AND applicable_device_id IS NOT NULL));
        DROP INDEX memories_active_scope;
        CREATE INDEX memories_active_scope ON memories(owner_id,scope,applicable_device_id,applicable_agent_id) WHERE NOT deleted;
        INSERT INTO schema_migrations(version) VALUES(4)`);
    }
    if (!(await c.query('SELECT 1 FROM schema_migrations WHERE version=5')).rowCount) {
      await c.query(`
        -- Protocol v3: Cloud Memory Brain, multi-platform devices, capability-free task routing & lease tracking
        DO $$ DECLARE r record; BEGIN FOR r IN SELECT conname FROM pg_constraint WHERE conrelid='devices'::regclass AND contype='c' LOOP EXECUTE format('ALTER TABLE devices DROP CONSTRAINT %I',r.conname); END LOOP; END $$;
        ALTER TABLE devices ADD CONSTRAINT devices_platform_check CHECK(platform IN ('macos','android','linux','windows','ios','web','other'));

        ALTER TABLE agents ADD COLUMN IF NOT EXISTS summary text NOT NULL DEFAULT '';

        ALTER TABLE memories ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'fact' CHECK(kind IN ('fact','preference','boundary','episode'));
        ALTER TABLE memories ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]';
        ALTER TABLE memories ADD COLUMN IF NOT EXISTS importance real NOT NULL DEFAULT 0.6 CHECK(importance >= 0 AND importance <= 1);
        ALTER TABLE memories ADD COLUMN IF NOT EXISTS access_count integer NOT NULL DEFAULT 0;
        ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz;
        ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding jsonb;
        ALTER TABLE memories ADD COLUMN IF NOT EXISTS search_tokens text NOT NULL DEFAULT '';
        CREATE INDEX IF NOT EXISTS memories_kind_updated ON memories(owner_id,kind,updated_at DESC) WHERE NOT deleted;

        CREATE TABLE IF NOT EXISTS memory_episodes(
          id uuid PRIMARY KEY,
          owner_id uuid NOT NULL,
          source_device_id uuid REFERENCES devices(id),
          source_agent_id uuid REFERENCES agents(id),
          session_key text,
          kind text NOT NULL DEFAULT 'turn' CHECK(kind IN ('turn','task_outcome','observation')),
          messages jsonb NOT NULL DEFAULT '[]',
          metadata jsonb NOT NULL DEFAULT '{}',
          summary text NOT NULL DEFAULT '',
          status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','consolidated','skipped','failed')),
          consolidation_result jsonb,
          created_at timestamptz NOT NULL DEFAULT now(),
          consolidated_at timestamptz
        );
        CREATE INDEX IF NOT EXISTS memory_episodes_recent ON memory_episodes(owner_id,created_at DESC);
        CREATE INDEX IF NOT EXISTS memory_episodes_status ON memory_episodes(owner_id,status,created_at);

        ALTER TABLE model_requests ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agents(id);
        CREATE INDEX IF NOT EXISTS model_agent_recent ON model_requests(agent_id,created_at);

        ALTER TABLE link_tasks ADD COLUMN IF NOT EXISTS instruction text;
        ALTER TABLE link_tasks ADD COLUMN IF NOT EXISTS lease_seconds integer NOT NULL DEFAULT 120;
        ALTER TABLE link_tasks ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
        ALTER TABLE link_tasks ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
        ALTER TABLE link_tasks ADD COLUMN IF NOT EXISTS progress jsonb;
        ALTER TABLE link_tasks ADD COLUMN IF NOT EXISTS memory_recorded boolean NOT NULL DEFAULT false;
        DO $$ DECLARE r record; BEGIN FOR r IN SELECT conname FROM pg_constraint WHERE conrelid='link_tasks'::regclass AND contype='c' LOOP EXECUTE format('ALTER TABLE link_tasks DROP CONSTRAINT %I',r.conname); END LOOP; END $$;
        ALTER TABLE link_tasks ADD CONSTRAINT link_tasks_state_check CHECK(state IN ('queued','running','cancel_requested','succeeded','failed','declined','cancelled','unknown','expired'));
        CREATE INDEX IF NOT EXISTS link_task_running_lease ON link_tasks(lease_expires_at) WHERE state IN ('running','cancel_requested') AND lease_expires_at IS NOT NULL;

        INSERT INTO schema_migrations(version) VALUES(5);
      `);
    }
    if (!(await c.query('SELECT 1 FROM schema_migrations WHERE version=6')).rowCount) {
      await c.query(`
        -- Protocol v3.0.1: unique short device slug for unambiguous cross-device routing
        ALTER TABLE devices ADD COLUMN IF NOT EXISTS slug text;
        CREATE UNIQUE INDEX IF NOT EXISTS devices_owner_slug_uniq ON devices(owner_id, lower(slug)) WHERE slug IS NOT NULL AND revoked_at IS NULL;
        INSERT INTO schema_migrations(version) VALUES(6);
      `);
    }
    if (!(await c.query('SELECT 1 FROM schema_migrations WHERE version=7')).rowCount) {
      await c.query(`
        -- Protocol v3.1 + v3.2: WS event cursor, receipt ACK, fencing token, retries, priorities, loop guard, suspend/reply, binary artifacts, SSE resume
        ALTER TABLE link_tasks ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 5;
        ALTER TABLE link_tasks ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 0;
        ALTER TABLE link_tasks ADD COLUMN IF NOT EXISTS max_retries integer NOT NULL DEFAULT 0;
        ALTER TABLE link_tasks ADD COLUMN IF NOT EXISTS idempotent boolean NOT NULL DEFAULT false;
        ALTER TABLE link_tasks ADD COLUMN IF NOT EXISTS lease_token uuid;
        ALTER TABLE link_tasks ADD COLUMN IF NOT EXISTS execution_timeout_seconds integer;
        ALTER TABLE link_tasks ADD COLUMN IF NOT EXISTS execution_deadline_at timestamptz;
        ALTER TABLE link_tasks ADD COLUMN IF NOT EXISTS concurrency_key text;
        ALTER TABLE link_tasks ADD COLUMN IF NOT EXISTS trace_id uuid;
        ALTER TABLE link_tasks ADD COLUMN IF NOT EXISTS parent_task_id uuid REFERENCES link_tasks(id);
        ALTER TABLE link_tasks ADD COLUMN IF NOT EXISTS call_depth integer NOT NULL DEFAULT 0;
        ALTER TABLE link_tasks ADD COLUMN IF NOT EXISTS call_chain jsonb NOT NULL DEFAULT '[]';
        ALTER TABLE link_tasks ADD COLUMN IF NOT EXISTS receipt_acked_at timestamptz;
        ALTER TABLE link_tasks ADD COLUMN IF NOT EXISTS pending_interaction jsonb;
        ALTER TABLE link_tasks ADD COLUMN IF NOT EXISTS interaction_expires_at timestamptz;

        DO $$ DECLARE r record; BEGIN FOR r IN SELECT conname FROM pg_constraint WHERE conrelid='link_tasks'::regclass AND contype='c' LOOP EXECUTE format('ALTER TABLE link_tasks DROP CONSTRAINT %I',r.conname); END LOOP; END $$;
        ALTER TABLE link_tasks ADD CONSTRAINT link_tasks_state_check CHECK(state IN ('queued','running','awaiting_input','awaiting_approval','cancel_requested','succeeded','failed','declined','cancelled','unknown','expired'));

        CREATE INDEX IF NOT EXISTS link_task_queued_expires ON link_tasks(expires_at) WHERE state='queued';
        CREATE INDEX IF NOT EXISTS link_task_waiting_expires ON link_tasks(interaction_expires_at) WHERE state IN ('awaiting_input','awaiting_approval') AND interaction_expires_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS link_task_unacked_receipts ON link_tasks(source_agent_id,finished_at DESC) WHERE receipt_acked_at IS NULL AND finished_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS link_task_concurrency_running ON link_tasks(owner_id,concurrency_key) WHERE state IN ('running','awaiting_input','awaiting_approval','cancel_requested') AND concurrency_key IS NOT NULL;

        CREATE TABLE IF NOT EXISTS edge_events(
          seq bigserial PRIMARY KEY,
          owner_id uuid NOT NULL,
          target_agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
          target_device_id uuid REFERENCES devices(id) ON DELETE CASCADE,
          event_type text NOT NULL,
          payload jsonb NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS edge_events_agent_seq ON edge_events(owner_id,target_agent_id,seq);
        CREATE INDEX IF NOT EXISTS edge_events_device_seq ON edge_events(owner_id,target_device_id,seq);
        CREATE INDEX IF NOT EXISTS edge_events_created ON edge_events(created_at);

        CREATE TABLE IF NOT EXISTS edge_artifacts(
          id uuid PRIMARY KEY,
          owner_id uuid NOT NULL,
          source_device_id uuid NOT NULL REFERENCES devices(id),
          source_agent_id uuid NOT NULL REFERENCES agents(id),
          task_id uuid REFERENCES link_tasks(id) ON DELETE SET NULL,
          filename text NOT NULL,
          content_type text NOT NULL,
          size_bytes integer NOT NULL CHECK(size_bytes >= 0),
          sha256 text NOT NULL,
          data bytea NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          expires_at timestamptz NOT NULL
        );
        CREATE INDEX IF NOT EXISTS edge_artifacts_owner_expires ON edge_artifacts(owner_id,expires_at);
        CREATE INDEX IF NOT EXISTS edge_artifacts_task ON edge_artifacts(task_id) WHERE task_id IS NOT NULL;

        ALTER TABLE model_requests ADD COLUMN IF NOT EXISTS response_snapshot jsonb;

        INSERT INTO schema_migrations(version) VALUES(7);
      `);
    }
    // Metadata only: a proxy crash cannot prove whether an upstream inference completed.
    await c.query("UPDATE model_requests SET state='submission_unknown',error_code='SERVICE_RESTARTED',finished_at=now() WHERE state='submitted'");
  });
}
