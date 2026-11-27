import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/app.js';
import {AnyLinkClient,AnyLinkError} from '../sdk/src/client.mjs';
import {AnyLinkWorker} from '../sdk/src/worker.mjs';
import {createMacLinkWorker} from '../examples/mac-openclaw/peer/link-worker.mjs';
const url=process.env.TEST_DATABASE_URL;
const joinKey='test-join-key-not-for-production-0000';
test('AnyLink SDK over real HTTP: join, agent routing and durable results',{skip:!url},async t=>{
  assert.equal(new URL(url!).pathname,'/anylink_test');
  const config={databaseUrl:url!,ownerToken:'test-owner-secret-not-production',deepseekApiKey:'test-deepseek-secret-not-production',deepseekBaseUrl:'http://127.0.0.1:1',defaultModel:'deepseek-flash',memoryModel:'deepseek-flash',embeddingModel:'',embeddingBaseUrl:'http://127.0.0.1:1',embeddingApiKey:'',models:[],allowAnyModel:false,gatewayAutoMemoryDefault:false,maxGlobalConcurrency:16,maxAgentConcurrency:4,maxAgentRpm:60,trustProxy:'loopback',origin:'http://127.0.0.1:3180',host:'127.0.0.1',port:3180,joinKey,loginPassword:'',personaFile:'examples/persona/dafeiyu.md',speechPrompt:'',leaseReaperIntervalMs:60000,memoryDebounceMs:0,memoryBatchMax:6};
  let instance=await createApp(config,{logger:false});
  await instance.app.listen({host:'127.0.0.1',port:0});
  const address=instance.app.server.address() as {port:number};const baseUrl=`http://127.0.0.1:${address.port}`;
  const cookie=String((await instance.app.inject({method:'POST',url:'/v1/auth/login',payload:{token:'test-owner-secret-not-production'}})).headers['set-cookie']).split(';')[0];
  const owner=async(p:string,body:unknown)=>{const r=await instance.app.inject({method:'POST',url:p,headers:{cookie,'idempotency-key':randomUUID()},payload:body as any});assert.equal(r.statusCode,200,r.body);return r.json();};
  async function connect(name:string,agentKey='default',installId='install-'+randomUUID()){
    const c=await AnyLinkClient.connect({baseUrl,joinKey,installId,device:{name,platform:'other'},agent:{key:agentKey,name:agentKey}});
    return {installId,deviceId:c.device_id,agentId:c.agent_id,credentialId:c.credential_id,token:c.token,client:new AnyLinkClient({baseUrl,token:c.token})};
  }
  const source=await connect('SDK sender'),target=await connect('SDK host'),stranger=await connect('Unpaired');
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'anylink-sdk-'));let worker:AnyLinkWorker|undefined;
  const input={target:{device_id:target.deviceId},capability:'text.reverse',input:{text:'AnyLink'}};
  try{
    await t.test('memory and task deployments do not require a model provider',async()=>{
      const memoryOnly=await createApp({...config,deepseekApiKey:''},{logger:false});
      try{
        const ready=await memoryOnly.app.inject({url:'/readyz'});assert.equal(ready.statusCode,200);assert.equal(ready.json().provider_configured,false);
        const models=await memoryOnly.app.inject({url:'/model/v1/models',headers:{authorization:`Bearer ${source.token}`}});assert.deepEqual(models.json().data,[]);
        const call=await memoryOnly.app.inject({method:'POST',url:'/model/v1/chat/completions',headers:{authorization:`Bearer ${source.token}`},payload:{model:'deepseek-flash',messages:[{role:'user',content:'test'}]}});
        assert.equal(call.statusCode,503);assert.equal(call.json().error.code,'PROVIDER_NOT_CONFIGURED');
      }finally{await memoryOnly.app.close();}
    });
    await t.test('connect upserts ids, rotates tokens and rejects bad keys',async()=>{
      const again=await AnyLinkClient.connect({baseUrl,joinKey,installId:source.installId,device:{name:'SDK sender renamed',platform:'other'},agent:{key:'default',name:'default'}});
      assert.equal(again.device_id,source.deviceId);assert.equal(again.agent_id,source.agentId);assert.notEqual(again.token,source.token);
      assert.equal((await instance.app.inject({url:'/edge/v1/identity',headers:{authorization:`Bearer ${source.token}`}})).statusCode,401);
      source.token=again.token;source.client=new AnyLinkClient({baseUrl,token:again.token});
      assert.equal((await instance.app.inject({method:'POST',url:'/edge/v1/connect',headers:{authorization:'Bearer wrong-key'},payload:{device:{install_id:'install-x',name:'x',platform:'other'},agent:{key:'a',name:'a'}}})).statusCode,401);
      const disabled=await createApp({...config,joinKey:''},{logger:false});
      try{assert.equal((await disabled.app.inject({method:'POST',url:'/edge/v1/connect',headers:{authorization:`Bearer ${joinKey}`},payload:{device:{install_id:'install-y',name:'y',platform:'other'},agent:{key:'a',name:'a'}}})).statusCode,503);}finally{await disabled.app.close();}
    });
    await t.test('protocol, directory, persona and context expose agent identity',async()=>{
      const p=await source.client.protocol();assert.equal(p.version,'3.2');assert.ok((p.routing as string[]).includes('device_name'));
      const d=await source.client.directory();assert.ok(d.items.some(i=>i.agents.some((a:any)=>a.self)));
      const persona=await source.client.persona();assert.equal(persona.name,'dafeiyu');assert.ok(persona.sha256.length===64);
      const c=await source.client.context();assert.equal(c.device_id,source.deviceId);assert.equal(c.agent_id,source.agentId);assert.ok(c.persona.content.includes('大肥鱼'));
      const id=await source.client.identity();assert.equal(id.device.id,source.deviceId);assert.equal(id.agent.id,source.agentId);assert.ok(id.scopes.includes('memory_brain'));
      const m=await source.client.saveMemory({scope:'device',applicable_device_id:source.deviceId,title:'SDK fixture '+randomUUID(),content:'This belongs to the sender'});
      assert.equal(m.source_device_id,source.deviceId);assert.equal(m.source_agent_id,source.agentId);await source.client.deleteMemory(m.id,m.revision);
    });
    await t.test('fresh agents create and claim tasks without capability gate',async()=>{
      await target.client.registerCapabilities([{name:'text.reverse',description:'Read-only text transform'}]);
      const task=await source.client.createTask(input);assert.equal(task.target_device_id,target.deviceId);assert.equal(task.target_agent_id,null);assert.equal(task.source_agent_id,source.agentId);
      assert.deepEqual((await target.client.claimTask()).task!.id,task.id);
      await target.client.completeTask(task.id,{state:'succeeded',output:{text:'done'}});
    });
    await t.test('empty polling does not grow the mutation journal and a key is consumed only on admission',async()=>{
      const key=randomUUID(),scope=target.agentId+':link:claim';
      const before=Number((await instance.db.query('SELECT count(*) AS n FROM mutation_keys WHERE scope=$1',[scope])).rows[0].n);
      for(let i=0;i<3;i++)assert.equal((await target.client.claimTask({idempotencyKey:key})).task,null);
      assert.equal(Number((await instance.db.query('SELECT count(*) AS n FROM mutation_keys WHERE scope=$1',[scope])).rows[0].n),before);
    });
    await t.test('create deduplicates, visibility is agent-scoped and results need the claimer',async()=>{
      const key=randomUUID(),task=await source.client.createTask(input,{idempotencyKey:key});
      assert.equal((await source.client.createTask(input,{idempotencyKey:key})).id,task.id);
      await assert.rejects(source.client.createTask({...input,input:{text:'different'}},{idempotencyKey:key}),(e:unknown)=>e instanceof AnyLinkError&&e.status===409);
      await assert.rejects(stranger.client.task(task.id),(e:unknown)=>e instanceof AnyLinkError&&e.status===404);
      await assert.rejects(stranger.client.completeTask(task.id,{state:'succeeded',output:{}}),(e:unknown)=>e instanceof AnyLinkError&&e.status===404);
      const claims=await Promise.all([target.client.claimTask(),target.client.claimTask()]);assert.equal(claims.filter(c=>c.task).length,1);
      await assert.rejects(source.client.completeTask(task.id,{state:'succeeded',output:{}}),(e:unknown)=>e instanceof AnyLinkError&&e.status===404);
      const resultKey=randomUUID(),result={state:'succeeded' as const,output:{text:'kniLynA'}};
      await target.client.completeTask(task.id,result,{idempotencyKey:resultKey});
      assert.equal((await target.client.completeTask(task.id,result,{idempotencyKey:resultKey})).state,'succeeded');
      assert.equal((await source.client.task(task.id)).result!.output!.text,'kniLynA');
    });
    await t.test('routing prefers agent-targeted, then device, then any; capability-free targeted tasks are claimable',async()=>{
      const other=await connect('Second host agent','alt');
      await other.client.registerCapabilities([{name:'text.reverse',description:'alt'}]);
      const anyTask=await source.client.createTask({capability:'text.reverse',input:{text:'any'}});
      const devTask=await source.client.createTask({target:{device_id:other.deviceId},capability:'text.reverse',input:{text:'dev'}});
      const agentTask=await source.client.createTask({target:{agent_id:other.agentId},capability:'text.reverse',input:{text:'agent'}});
      const claimed=(await other.client.claimTask()).task!;assert.equal(claimed.id,agentTask.id,'agent-targeted wins over older any/device tasks');
      await other.client.completeTask(claimed.id,{state:'succeeded',output:{}});
      assert.equal((await other.client.claimTask()).task!.id,devTask.id);await other.client.completeTask(devTask.id,{state:'succeeded',output:{}});
      assert.equal((await other.client.claimTask()).task!.id,anyTask.id);await other.client.completeTask(anyTask.id,{state:'succeeded',output:{}});
      const directTask=await source.client.createTask({target:{agent_id:stranger.agentId},instruction:'Try something'});
      const strangerClaimed=(await stranger.client.claimTask()).task!;assert.equal(strangerClaimed.id,directTask.id);
      await stranger.client.completeTask(strangerClaimed.id,{state:'declined',error:{code:'UNSUPPORTED',message:'Cannot do this here'}});
    });
    await t.test('worker recovers a lost result response without executing twice',async()=>{
      let calls=0,loseResponse=true;
      const faulty=new AnyLinkClient({baseUrl,token:target.token,fetch:async(u,options)=>{const r=await fetch(u,options);if(String(u).endsWith('/result')&&loseResponse){loseResponse=false;await r.arrayBuffer();throw new Error('Connection lost after commit');}return r;}});
      worker=new AnyLinkWorker({client:faulty,journalPath:path.join(folder,'journal.sqlite'),handlers:{'text.reverse':{description:'Read-only transform',async execute(v){calls++;return {text:String(v.text).split('').reverse().join('')};}}}});
      await worker.advertise();const task=await source.client.createTask(input);
      await assert.rejects(worker.runNext(),(e:unknown)=>e instanceof AnyLinkError&&e.submissionUnknown);
      assert.equal((await source.client.task(task.id)).state,'succeeded');
      await worker.recoverResults();assert.equal(await worker.runNext(),null);assert.equal(calls,1);
    });
    await t.test('cancel and expiry never admit queued work',async()=>{
      const task=await source.client.createTask(input);assert.equal((await source.client.cancelTask(task.id)).state,'cancelled');assert.equal((await target.client.claimTask()).task,null);
      const expired=await source.client.createTask(input);await instance.db.query("UPDATE link_tasks SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);
      assert.equal((await source.client.task(expired.id)).state,'expired');assert.equal((await target.client.claimTask()).task,null);
    });
    await t.test('state filters are applied before the newest-100 limit',async()=>{
      const queued=await source.client.createTask({...input,target:{agent_id:target.agentId}});await instance.db.query("UPDATE link_tasks SET created_at=now()-interval '1 hour' WHERE id=$1",[queued.id]);
      await instance.db.query(`INSERT INTO link_tasks(id,owner_id,source_device_id,source_agent_id,target_device_id,capability,input,state,expires_at,finished_at,source_credential_id)
        SELECT gen_random_uuid(),'00000000-0000-4000-8000-000000000001',$1,$2,$3,'text.reverse','{}','succeeded',now()+interval '1 hour',now(),$4 FROM generate_series(1,101)`,[source.deviceId,source.agentId,target.deviceId,source.credentialId]);
      assert.ok((await target.client.listTasks({role:'target',state:'queued'})).items.some(t=>t.id===queued.id));await source.client.cancelTask(queued.id);
    });
    await t.test('server restart retains running work without requeueing execution',async()=>{
      const task=await source.client.createTask(input);assert.equal((await target.client.claimTask()).task!.id,task.id);
      await instance.app.close();instance=await createApp(config,{logger:false});await instance.app.listen({host:'127.0.0.1',port:address.port});
      assert.equal((await target.client.claimTask()).task,null);assert.equal((await source.client.task(task.id)).state,'running');
      await target.client.completeTask(task.id,{state:'unknown',error:{code:'HOST_INSPECTION_REQUIRED',message:'Inspect the host before deciding whether any new task is safe'}});
      assert.equal((await source.client.task(task.id)).state,'unknown');
    });
    await t.test('Mac reference worker returns a real read-only file receipt through the cloud protocol',async()=>{
      const roots=path.join(folder,'mac-workspace');fs.mkdirSync(roots);fs.writeFileSync(path.join(roots,'anylink-report.txt'),'content must remain unchanged');
      const policyFile=path.join(folder,'mac-policy.json');fs.writeFileSync(policyFile,JSON.stringify({device_id:target.deviceId,roots:[{id:'workspace',label:'Test workspace',path:roots}]}));
      const macWorker=createMacLinkWorker({connection:{server:baseUrl,token:target.token,device_id:target.deviceId},policyFile,journalPath:path.join(folder,'mac-link.sqlite')});
      try{
        await macWorker.advertise();
        const task=await source.client.createTask({target:{device_id:target.deviceId},capability:'files.search',input:{query:'anylink-report',scope:'workspace'}});
        await macWorker.runNext();const receipt=await source.client.task(task.id);
        assert.equal(receipt.state,'succeeded');assert.equal((receipt.result!.output!.matches as any[])[0].name,'anylink-report.txt');
        assert.equal(fs.readFileSync(path.join(roots,'anylink-report.txt'),'utf8'),'content must remain unchanged');
      }finally{macWorker.close();await target.client.registerCapabilities([{name:'text.reverse',description:'Read-only text transform'}]);}
    });
    await t.test('revoked agents lose access and their targeted tasks become unclaimable',async()=>{
      const doomed=await connect('Doomed agent','doomed');
      await doomed.client.registerCapabilities([{name:'text.reverse',description:'x'}]);
      const targeted=await source.client.createTask({target:{agent_id:doomed.agentId},capability:'text.reverse',input:{text:'x'}});
      await owner(`/v1/agents/${doomed.agentId}/revoke`,{});
      assert.equal((await instance.app.inject({url:'/edge/v1/identity',headers:{authorization:`Bearer ${doomed.token}`}})).statusCode,401);
      assert.equal((await target.client.claimTask()).task,null,'agent-targeted task is not claimable by other agents');
      assert.equal((await source.client.task(targeted.id)).state,'queued');
      await owner(`/v1/agents/${doomed.agentId}/restore`,{});
      const reconnected=await AnyLinkClient.connect({baseUrl,joinKey,installId:doomed.installId,device:{name:'Doomed agent',platform:'other'},agent:{key:'doomed',name:'doomed'}});
      const revived=new AnyLinkClient({baseUrl,token:reconnected.token});
      assert.equal((await revived.claimTask()).task!.id,targeted.id,'restored agent can claim its targeted task after reconnect');
      await revived.completeTask(targeted.id,{state:'succeeded',output:{}});
    });
  }finally{worker?.close();await instance.app.close();fs.rmSync(folder,{recursive:true,force:true});}
});
