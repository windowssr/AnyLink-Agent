import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createApp} from '../server/app.js';
import type {Config} from '../server/config.js';
const url=process.env.TEST_DATABASE_URL;
test('edge services: identity, memory, transparent model proxy and retirement',{skip:!url},async t=>{
  assert.equal(new URL(url!).pathname,'/anylink_test');
  const setup=new pg.Pool({connectionString:url});await setup.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await setup.end();
  let calls=0,lastBody:any,hold:(()=>void)|undefined;
  const upstream=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer test-deepseek-secret-not-production');
    let body='';for await(const c of req)body+=c;lastBody=JSON.parse(body);calls++;
    const mode=lastBody.messages.at(-1)?.content;
    if(mode==='reject'){res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"fixture"}');return;}
    if(mode==='hold')await new Promise<void>(resolve=>{hold=resolve;});
    if(lastBody.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":"read","arguments":"{\\"path\\":\\"note.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n');
      if(mode==='broken'){res.end();return;}
      res.end('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\ndata: [DONE]\n\n');
    }else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'回复中文',tool_calls:[{id:'call_x',type:'function',function:{name:'read',arguments:'{"path":"note.txt"}'}}]}}],usage:{prompt_tokens:12,completion_tokens:3}}));}
  });
  await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
  const config:Config={databaseUrl:url!,ownerToken:'test-owner-secret-not-production',deepseekApiKey:'test-deepseek-secret-not-production',deepseekBaseUrl:`http://127.0.0.1:${(upstream.address() as any).port}/v1`,origin:'http://127.0.0.1:3180',host:'127.0.0.1',port:3180};
  let instance=await createApp(config,{logger:false});let cookie='',device:any,android:any,token='',memory:any;
  async function owner(method:string,path:string,body?:unknown,key=randomUUID(),headers:Record<string,string>={}){return instance.app.inject({method:method as any,url:path,headers:{cookie,'idempotency-key':key,...headers},payload:body});}
  async function edge(method:string,path:string,body?:unknown,key=randomUUID(),credential=token){return instance.app.inject({method:method as any,url:path,headers:{authorization:`Bearer ${credential}`,'idempotency-key':key},payload:body});}
  const model=(content:string,stream=false,extra={})=>edge('POST','/model/v1/chat/completions',{model:'deepseek-flash',messages:[{role:'user',content}],stream,...extra});
  try{
    await t.test('owner authentication and no cloud agent endpoint',async()=>{
      assert.equal((await owner('GET','/v1/devices')).statusCode,401);
      const r=await owner('POST','/v1/auth/login',{token:config.ownerToken});cookie=String(r.headers['set-cookie']).split(';')[0];assert.equal(r.statusCode,200);
      assert.equal((await owner('GET','/v1/status')).json().cloud_agent,false);
      for(const path of ['/v1/conversations','/v1/tasks','/v1/conversations/'+randomUUID()+'/messages'])assert.equal((await owner('POST',path,{})).statusCode,410);
      assert.equal((await owner('POST','/v1/devices',{name:'x',platform:'macos'},randomUUID(),{origin:'https://other.example'})).statusCode,403);
    });
    await t.test('device credentials are one-time and only hashes are persisted',async()=>{
      const key=randomUUID(),body={name:'Mac fixture',platform:'macos'};device=(await owner('POST','/v1/devices',body,key)).json();
      assert.equal((await owner('POST','/v1/devices',body,key)).json().id,device.id);
      android=(await owner('POST','/v1/devices',{name:'Android fixture',platform:'android'})).json();
      const bound=await owner('POST',`/v1/devices/${device.id}/credential`,{});assert.equal(bound.statusCode,201);token=bound.json().token;
      assert.equal((await owner('POST',`/v1/devices/${device.id}/credential`,{})).statusCode,409);
      assert.equal((await edge('GET','/edge/v1/identity')).json().device.id,device.id);
      assert.equal((await edge('GET','/v1/devices')).statusCode,401);
      const stored=JSON.stringify((await instance.db.query('SELECT * FROM edge_credentials')).rows);assert.equal(stored.includes(token),false);
      assert.equal((await edge('GET','/model/v1/models',undefined,undefined,'bad-token')).statusCode,401);
    });
    await t.test('memory source, scope, idempotency and context',async()=>{
      const body={title:'工程目录',content:'Mac-path',scope:'device',applicable_device_id:device.id},key=randomUUID();
      memory=(await edge('POST','/edge/v1/memories',body,key)).json();assert.equal(memory.source_device_id,device.id);
      assert.equal((await edge('POST','/edge/v1/memories',body,key)).json().id,memory.id);
      assert.equal((await edge('POST','/edge/v1/memories',{...body,content:'other'},key)).statusCode,409);
      await owner('POST','/v1/memories',{title:'手机目录',content:'Android-path',scope:'device',applicable_device_id:android.id});
      await owner('POST','/v1/memories',{title:'偏好',content:'中文',scope:'global'});
      const c=(await edge('GET','/edge/v1/context')).json();assert.equal(c.device.length,1);assert.equal(c.global.length,1);assert.equal(c.directory.entries[0].id,memory.id);
    });
    await t.test('memory CAS and immediate tombstone visibility',async()=>{
      assert.equal((await edge('PATCH',`/edge/v1/memories/${memory.id}`,{content:'new-path',expected_revision:1})).json().revision,2);
      assert.equal((await edge('PATCH',`/edge/v1/memories/${memory.id}`,{content:'stale',expected_revision:1})).statusCode,409);
      assert.equal((await owner('DELETE',`/v1/memories/${memory.id}`,undefined,randomUUID(),{'if-match':'2'})).statusCode,200);
      assert.equal((await edge('GET',`/edge/v1/memories/${memory.id}`)).statusCode,404);
      assert.equal((await edge('GET','/edge/v1/context')).json().device.length,0);
    });
    await t.test('models, tools and non-stream responses are passed through without an agent',async()=>{
      const schema={type:'function',function:{name:'read',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}};
      const r=await model('plain',false,{tools:[schema],tool_choice:'auto'});assert.equal(r.statusCode,200);assert.equal(r.json().choices[0].message.tool_calls[0].function.name,'read');assert.deepEqual(lastBody.tools,[schema]);
      const tool=await edge('POST','/model/v1/chat/completions',{model:'deepseek-flash',messages:[{role:'assistant',content:null,tool_calls:[{id:'call_x'}]},{role:'tool',tool_call_id:'call_x',content:'actual local file'}]});assert.equal(tool.statusCode,200);assert.equal(lastBody.messages[1].tool_call_id,'call_x');
      assert.equal((await model('bad',false,{model:'other-model'})).statusCode,400);
    });
    await t.test('SSE tool calls and usage pass through byte-for-byte',async()=>{
      const r=await model('stream',true);assert.match(String(r.headers['content-type']),/event-stream/);assert.match(r.body,/"tool_calls"/);assert.match(r.body,/data: \[DONE\]/);
      const record=(await instance.db.query('SELECT * FROM model_requests WHERE id=$1',[r.headers['x-anylink-request-id']])).rows[0];assert.equal(record.state,'completed');assert.equal(record.prompt_tokens,12);
      for(const forbidden of ['messages','prompt','response_text','tool_calls'])assert.equal(forbidden in record,false);
    });
    await t.test('upstream rejections and interrupted streams are not replayed',async()=>{
      const before=calls;assert.equal((await model('reject')).statusCode,503);assert.equal(calls,before+1);
      const r=await model('broken',true);assert.equal((await instance.db.query('SELECT state FROM model_requests WHERE id=$1',[r.headers['x-anylink-request-id']])).rows[0].state,'submission_unknown');assert.equal(calls,before+2);
    });
    await t.test('per-device concurrency admission prevents a second inference',async()=>{
      const pending=model('hold');while(!hold)await new Promise(r=>setTimeout(r,10));const before=calls;
      assert.equal((await model('second')).statusCode,429);assert.equal(calls,before);hold!();await pending;
    });
    await t.test('credential revocation blocks model and memory, owner remains valid',async()=>{
      await owner('POST',`/v1/devices/${device.id}/revoke`,{});assert.equal((await edge('GET','/edge/v1/context')).statusCode,401);assert.equal((await model('no')).statusCode,401);assert.equal((await owner('GET','/v1/devices')).statusCode,200);
    });
    await t.test('service restart retains facts and quarantines uncertain proxy requests',async()=>{
      const credential=(await instance.db.query('SELECT id FROM edge_credentials LIMIT 1')).rows[0].id,id=randomUUID();
      await instance.db.query("INSERT INTO model_requests(id,credential_id,device_id,model,state) VALUES($1,$2,$3,'deepseek-flash','submitted')",[id,credential,device.id]);
      const before=calls;await instance.app.close();instance=await createApp(config,{logger:false});assert.equal(calls,before);
      assert.equal((await instance.db.query('SELECT state FROM model_requests WHERE id=$1',[id])).rows[0].state,'submission_unknown');assert.equal((await owner('GET','/v1/memories')).json().items.length,2);
    });
  }finally{hold?.();await instance.app.close();await new Promise<void>(r=>upstream.close(()=>r()));}
});
