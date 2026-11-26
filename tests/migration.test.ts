import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {createDb,migrate,hash} from '../server/db.js';
import {createApp} from '../server/app.js';
const url=process.env.TEST_DATABASE_URL;
test('migration v3 to v4 backfills agents, moves capabilities and drops grants',{skip:!url},async()=>{
  assert.equal(new URL(url!).pathname,'/anylink_test');
  const setup=new pg.Pool({connectionString:url});await setup.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await setup.end();
  const db=createDb(url!);
  // Recreate the v3-era tables exactly as migration versions 1-3 left them.
  await db.query(`CREATE TABLE devices(id uuid PRIMARY KEY,owner_id uuid NOT NULL,name text NOT NULL,platform text NOT NULL CHECK(platform IN ('macos','android','other')),revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE edge_credentials(id uuid PRIMARY KEY,device_id uuid NOT NULL REFERENCES devices(id),token_hash text NOT NULL UNIQUE,created_at timestamptz NOT NULL DEFAULT now(),last_used_at timestamptz,revoked_at timestamptz);
    CREATE UNIQUE INDEX one_edge_credential ON edge_credentials(device_id) WHERE revoked_at IS NULL;
    CREATE TABLE model_requests(id uuid PRIMARY KEY,credential_id uuid NOT NULL REFERENCES edge_credentials(id),device_id uuid NOT NULL REFERENCES devices(id),model text NOT NULL,state text NOT NULL CHECK(state IN ('submitted','completed','rejected','submission_unknown','cancelled')),prompt_tokens integer,completion_tokens integer,error_code text,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz);
    CREATE INDEX model_device_recent ON model_requests(device_id,created_at);
    CREATE TABLE link_capabilities(device_id uuid PRIMARY KEY REFERENCES devices(id),capabilities jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE link_grants(source_device_id uuid NOT NULL REFERENCES devices(id),target_device_id uuid NOT NULL REFERENCES devices(id),capability text NOT NULL,enabled boolean NOT NULL DEFAULT false,PRIMARY KEY(source_device_id,target_device_id,capability));
    CREATE TABLE link_tasks(id uuid PRIMARY KEY,owner_id uuid NOT NULL,source_device_id uuid NOT NULL REFERENCES devices(id),source_credential_id uuid NOT NULL REFERENCES edge_credentials(id),target_device_id uuid NOT NULL REFERENCES devices(id),capability text NOT NULL,input jsonb NOT NULL,state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','cancel_requested','succeeded','failed','cancelled','unknown','expired')),result jsonb,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,started_at timestamptz,finished_at timestamptz);
    CREATE INDEX link_task_queue ON link_tasks(target_device_id,created_at) WHERE state='queued';
    CREATE INDEX link_task_source ON link_tasks(source_device_id,created_at);
    CREATE TABLE memories(id uuid PRIMARY KEY,owner_id uuid NOT NULL,title text NOT NULL,content text NOT NULL,scope text NOT NULL CHECK(scope IN ('global','device')),applicable_device_id uuid REFERENCES devices(id),source_device_id uuid REFERENCES devices(id),source_request_id uuid,source_kind text NOT NULL,revision integer NOT NULL DEFAULT 1,deleted boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),CHECK((scope='global' AND applicable_device_id IS NULL) OR (scope='device' AND applicable_device_id IS NOT NULL)));
    CREATE INDEX memories_active_scope ON memories(owner_id,scope,applicable_device_id) WHERE NOT deleted;
    CREATE TABLE schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO schema_migrations(version) VALUES(1),(2),(3)`);
  const owner='00000000-0000-4000-8000-000000000001',deviceId=randomUUID(),credentialId=randomUUID(),token='ak_legacy_migration_token_'+randomUUID().replaceAll('-','');
  await db.query("INSERT INTO devices(id,owner_id,name,platform) VALUES($1,$2,'Legacy Mac','macos')",[deviceId,owner]);
  await db.query('INSERT INTO edge_credentials(id,device_id,token_hash) VALUES($1,$2,$3)',[credentialId,deviceId,hash(token)]);
  await db.query("INSERT INTO link_capabilities(device_id,capabilities) VALUES($1,'[{\"name\":\"files.search\",\"description\":\"legacy\"}]')",[deviceId]);
  await db.query('INSERT INTO link_grants(source_device_id,target_device_id,capability,enabled) VALUES($1,$1,$2,true)',[deviceId,'files.search']);
  await db.query("INSERT INTO link_tasks(id,owner_id,source_device_id,source_credential_id,target_device_id,capability,input,state,expires_at) VALUES($1,$2,$3,$4,$3,'files.search','{}','running',now()+interval '1 hour')",[randomUUID(),owner,deviceId,credentialId]);
  await db.query("INSERT INTO memories(id,owner_id,title,content,scope,applicable_device_id,source_kind) VALUES($1,$2,'fact','v3 fact','device',$3,'owner_edit')",[randomUUID(),owner,deviceId]);
  await migrate(db);
  const agent=(await db.query("SELECT * FROM agents WHERE device_id=$1 AND key='default'",[deviceId])).rows[0];
  assert.ok(agent);assert.equal(agent.kind,'legacy');assert.equal(agent.name,'Legacy Mac');
  assert.deepEqual(agent.capabilities,[{name:'files.search',description:'legacy'}]);
  const cred=(await db.query('SELECT agent_id FROM edge_credentials WHERE id=$1',[credentialId])).rows[0];
  assert.equal(cred.agent_id,agent.id);
  const task=(await db.query('SELECT source_agent_id,target_device_id,claimed_by_agent_id FROM link_tasks')).rows[0];
  assert.equal(task.source_agent_id,agent.id);assert.equal(task.target_device_id,deviceId);assert.equal(task.claimed_by_agent_id,agent.id);
  for(const table of ['link_grants','link_capabilities'])assert.equal((await db.query('SELECT to_regclass($1) AS t',[table])).rows[0].t,null,table+' dropped');
  assert.ok((await db.query("SELECT conname FROM pg_constraint WHERE conrelid='memories'::regclass AND contype='c'")).rows.length>=2,'named memory checks exist');
  assert.equal((await db.query('SELECT max(version) AS v FROM schema_migrations')).rows[0].v,6,'migrated cleanly through v6');
  assert.ok((await db.query("SELECT to_regclass('memory_episodes') AS t")).rows[0].t,'memory_episodes table created');
  // The old token authenticates as the default agent with moved capabilities.
  const app=await createApp({databaseUrl:url!,ownerToken:'o'.repeat(30),deepseekApiKey:'',deepseekBaseUrl:'http://127.0.0.1:1',defaultModel:'deepseek-flash',memoryModel:'deepseek-flash',embeddingModel:'',embeddingBaseUrl:'http://127.0.0.1:1',embeddingApiKey:'',models:[],allowAnyModel:false,gatewayAutoMemoryDefault:false,maxGlobalConcurrency:16,maxAgentConcurrency:4,maxAgentRpm:60,trustProxy:'loopback',origin:'http://127.0.0.1:3180',host:'127.0.0.1',port:3180,joinKey:'',personaFile:'persona/dafeiyu.md',speechPrompt:'',leaseReaperIntervalMs:60000,memoryDebounceMs:0,memoryBatchMax:6},{logger:false});
  try{
    const identity=await app.app.inject({url:'/edge/v1/identity',headers:{authorization:`Bearer ${token}`}});
    assert.equal(identity.statusCode,200,identity.body);const j=identity.json();
    assert.equal(j.device.id,deviceId);assert.equal(j.agent.id,agent.id);assert.equal(j.agent.key,'default');assert.deepEqual(j.agent.capabilities,[{name:'files.search',description:'legacy'}]);
  }finally{await app.app.close();await db.end();}
  // migrate() is re-runnable.
  const db2=createDb(url!);await migrate(db2);await db2.end();
});
