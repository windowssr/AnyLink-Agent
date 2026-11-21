import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../server/app.js';
import type { Config } from '../server/config.js';
import { executeTool } from '../server/tools.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
test('PostgreSQL + HTTP + tool loop + failure recovery',{skip:!databaseUrl},async t=>{
  // Never permit this destructive fixture setup against the product database.
  assert.equal(new URL(databaseUrl!).pathname,'/anylink_test','Integration tests require a dedicated anylink_test database');
  const setup=new pg.Pool({connectionString:databaseUrl});await setup.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await setup.end();
  let upstreamCalls=0;let releaseConcurrent:(()=>void)|undefined;
  const gateway=createServer(async(req,res)=>{
    if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end('{"data":[{"id":"openclaw/default"}]}');return;}
    let text='';for await(const chunk of req)text+=chunk;
    const body=JSON.parse(text);upstreamCalls++;
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const emit=(delta:unknown,finish_reason:string|null=null)=>res.write(`data: ${JSON.stringify({choices:[{delta,finish_reason}]})}\n\n`);
    const original=body.messages.find((m:any)=>m.role==='user')?.content??'';
    if(original.includes('断线')){emit({content:'部分结果'});res.end();return;}
    if(original.includes('并发'))await new Promise<void>(resolve=>{releaseConcurrent=resolve;});
    if(original.includes('记住')&&!body.messages.some((m:any)=>m.role==='tool')){
      emit({tool_calls:[{index:0,id:'call_fixture_save',type:'function',function:{name:'anylink_memory_save',arguments:JSON.stringify({title:'工具偏好',content:'喜欢简洁中文',scope:'global'})}}]},'tool_calls');
    }else{
      emit({content:body.messages.some((m:any)=>m.role==='tool')?'已保存记忆。':'这是测试'});
      emit({content:'回复。'},'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(r=>gateway.listen(0,'127.0.0.1',r));
  const port=(gateway.address() as {port:number}).port;
  const config:Config={databaseUrl:databaseUrl!,ownerToken:'test-owner-token-not-a-real-secret-1234',gatewayToken:'test-gateway-token-not-a-real-secret-1234',gatewayUrl:`http://127.0.0.1:${port}`,origin:'http://127.0.0.1:3180',host:'127.0.0.1',port:3180};
  let instance=await createApp(config,{logger:false});let cookie='';
  async function call(method:string,path:string,body?:unknown,key=randomUUID(),extra:Record<string,string>={}){
    return instance.app.inject({method:method as any,url:path,headers:{cookie,'idempotency-key':key,...extra},payload:body});
  }
  async function waitFor(id:string){for(let i=0;i<200;i++){const r=(await call('GET',`/v1/requests/${id}`)).json();if(['completed','submission_unknown','failed'].includes(r.state))return r;await new Promise(r=>setTimeout(r,20));}throw new Error('run did not settle');}
  let mac:any,android:any,memory:any,conversation:any,task:any;
  try{
    await t.test('authentication, origin guard and private data',async()=>{
      assert.equal((await call('GET','/v1/devices')).statusCode,401);
      const login=await call('POST','/v1/auth/login',{token:config.ownerToken});assert.equal(login.statusCode,200);
      const header=login.headers['set-cookie'];cookie=String(Array.isArray(header)?header[0]:header).split(';')[0];
      assert.match(String(header),/HttpOnly/);assert.match(String(header),/SameSite=Strict/);
      assert.equal((await call('POST','/v1/devices',{name:'bad',platform:'macos'},randomUUID(),{origin:'https://untrusted.example'})).statusCode,403);
    });
    await t.test('device creation is idempotent; key conflicts are rejected',async()=>{
      const key=randomUUID(),body={name:'Mac 测试',platform:'macos'};
      mac=(await call('POST','/v1/devices',body,key)).json();
      assert.equal(mac.executor_connected,false);
      assert.equal((await call('POST','/v1/devices',body,key)).json().id,mac.id);
      assert.equal((await call('POST','/v1/devices',{...body,name:'different'},key)).statusCode,409);
      android=(await call('POST','/v1/devices',{name:'Android 测试',platform:'android'})).json();
      assert.equal((await call('GET','/v1/devices')).json().items.length,2);
    });
    await t.test('public static UI does not expose encoded private API paths',async()=>{
      for(const path of ['/v1%2fdevices','/v1/../v1/devices','/assets/../../secrets/app.env']){
        const r=await instance.app.inject({method:'GET',url:path});
        assert.notEqual(r.statusCode,200,path);
      }
    });
    await t.test('scope validation, revision CAS and immediate deletion visibility',async()=>{
      assert.equal((await call('POST','/v1/memories',{title:'错范围',content:'x',scope:'device'})).statusCode,400);
      memory=(await call('POST','/v1/memories',{title:'工程目录',content:'/work/papers',scope:'device',applicable_device_id:mac.id})).json();
      const edit=await call('PATCH',`/v1/memories/${memory.id}`,{content:'/work/new',expected_revision:1});assert.equal(edit.json().revision,2);
      assert.equal((await call('PATCH',`/v1/memories/${memory.id}`,{content:'stale',expected_revision:1})).statusCode,409);
      const directory=(await call('GET',`/v1/devices/${mac.id}/memory-directory`)).json();assert.equal(directory.entries[0].revision,2);
      assert.equal((await call('POST','/v1/memories/search',{device_id:android.id})).json().items.length,0);
      const revisions=(await call('GET',`/v1/memories/${memory.id}/revisions`)).json();assert.equal(revisions.items.length,2);
      assert.equal((await call('DELETE',`/v1/memories/${memory.id}`,undefined,randomUUID(),{'if-match':'1'})).statusCode,409);
      assert.equal((await call('DELETE',`/v1/memories/${memory.id}`,undefined,randomUUID(),{'if-match':'2'})).statusCode,200);
      assert.equal((await call('GET',`/v1/memories/${memory.id}`)).statusCode,404);
      assert.equal((await call('GET',`/v1/devices/${mac.id}/memory-directory`)).json().entries.length,0);
    });
    await t.test('tasks preserve origin and target and cannot execute',async()=>{
      const key=randomUUID(),body={goal:'整理测试目录',origin_device_id:android.id,target_device_id:mac.id};
      task=(await call('POST','/v1/tasks',body,key)).json();assert.equal(task.status,'waiting_device');assert.equal(task.execution_enabled,false);
      assert.equal((await call('POST','/v1/tasks',body,key)).json().id,task.id);
      const detail=(await call('GET',`/v1/tasks/${task.id}`)).json();assert.equal(detail.origin_device_id,android.id);assert.equal(detail.target_device_id,mac.id);
      assert.equal((await call('POST',`/v1/tasks/${task.id}/cancel`,{})).json().status,'cancelled');
    });
    await t.test('real streaming adapter and duplicate request admission',async()=>{
      conversation=(await call('POST','/v1/conversations',{title:'测试对话'})).json();
      const id=randomUUID(),body={request_id:id,message:'你好'};const before=upstreamCalls;
      assert.equal((await call('POST',`/v1/conversations/${conversation.id}/messages`,body,id)).statusCode,202);
      const settled=await waitFor(id);assert.equal(settled.state,'completed');assert.equal(settled.response_text,'这是测试回复。');
      assert.equal((await call('POST',`/v1/conversations/${conversation.id}/messages`,body,id)).json().replayed,true);
      assert.equal(upstreamCalls,before+1);
      const events=await call('GET',`/v1/requests/${id}/events`);assert.match(events.body,/snapshot/);assert.match(events.body,/completed/);
    });
    await t.test('tool loop writes once and uses trusted source from request',async()=>{
      const id=randomUUID();await call('POST',`/v1/conversations/${conversation.id}/messages`,{request_id:id,message:'记住工具保存偏好',origin_device_id:android.id},id);
      const settled=await waitFor(id);assert.equal(settled.state,'completed');assert.equal(settled.tool_rounds,1);
      const facts=(await call('GET','/v1/memories')).json().items;const fact=facts.find((m:any)=>m.title==='工具偏好');assert.ok(fact);assert.equal(fact.source_device_id,android.id);
      const context={deviceId:android.id,requestId:id,kind:'owner_statement_declared_device',conversationId:conversation.id,allowMemoryWrite:true};
      await executeTool(instance.db,context,'anylink_memory_save',JSON.stringify({title:'工具偏好',content:'喜欢简洁中文',scope:'global'}),'call_fixture_save');
      assert.equal((await call('GET','/v1/memories')).json().items.filter((m:any)=>m.title==='工具偏好').length,1);
      const denied=await executeTool(instance.db,{...context,allowMemoryWrite:false},'anylink_memory_save','{}','denied') as any;assert.equal(denied.error.code,'TOOL_NOT_ALLOWED');
    });
    await t.test('interrupted stream is unknown and never automatically retried',async()=>{
      const id=randomUUID(),body={request_id:id,message:'断线测试'},before=upstreamCalls;
      await call('POST',`/v1/conversations/${conversation.id}/messages`,body,id);const result=await waitFor(id);assert.equal(result.state,'submission_unknown');assert.equal(result.response_text,'部分结果');
      await call('POST',`/v1/conversations/${conversation.id}/messages`,body,id);assert.equal(upstreamCalls,before+1);
    });
    await t.test('global admission permits only one run',async()=>{
      const id=randomUUID();await call('POST',`/v1/conversations/${conversation.id}/messages`,{request_id:id,message:'并发测试'},id);
      for(let i=0;i<500&&!releaseConcurrent;i++)await new Promise(r=>setTimeout(r,20));
      assert.ok(releaseConcurrent,'first run reached the upstream barrier');
      try{const other=randomUUID();assert.equal((await call('POST',`/v1/conversations/${conversation.id}/messages`,{request_id:other,message:'第二条'},other)).statusCode,409);}
      finally{releaseConcurrent?.();releaseConcurrent=undefined;}
      await waitFor(id);
    });
    await t.test('restart preserves facts/tasks and quarantines unfinished requests',async()=>{
      const id=randomUUID();await instance.db.query("INSERT INTO requests(id,owner_id,conversation_id,body_hash,message,state) VALUES($1,'00000000-0000-4000-8000-000000000001',$2,'fixture','unconfirmed','submitted')",[id,conversation.id]);
      const before=upstreamCalls;await instance.app.close();instance=await createApp(config,{logger:false});
      assert.equal((await call('GET',`/v1/requests/${id}`)).json().state,'submission_unknown');assert.equal(upstreamCalls,before);
      assert.equal((await call('GET','/v1/tasks')).json().items.length,1);assert.equal((await call('GET','/v1/memories')).json().items.length,1);
      assert.equal((await call('GET','/readyz')).statusCode,200);
    });
  }finally{await instance.app.close();await new Promise<void>(r=>gateway.close(()=>r()));}
});
