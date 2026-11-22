import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/app.js';
import {AnyLinkClient,AnyLinkError} from '../sdk/src/client.mjs';
import {AnyLinkWorker} from '../sdk/src/worker.mjs';
import {createMacLinkWorker} from '../mac/peer/link-worker.mjs';
const url=process.env.TEST_DATABASE_URL;
test('AnyLink SDK over real HTTP: grants, task delivery and durable results',{skip:!url},async t=>{
  assert.equal(new URL(url!).pathname,'/anylink_test');
  const config={databaseUrl:url!,ownerToken:'test-owner-secret-not-production',deepseekApiKey:'test-deepseek-secret-not-production',deepseekBaseUrl:'http://127.0.0.1:1',origin:'http://127.0.0.1:3180',host:'127.0.0.1',port:3180};
  let instance=await createApp(config,{logger:false});
  await instance.app.listen({host:'127.0.0.1',port:0});
  const address=instance.app.server.address() as {port:number};const baseUrl=`http://127.0.0.1:${address.port}`;
  const cookie=String((await instance.app.inject({method:'POST',url:'/v1/auth/login',payload:{token:'test-owner-secret-not-production'}})).headers['set-cookie']).split(';')[0];
  const owner=async(p:string,body:unknown)=>{const r=await instance.app.inject({method:'POST',url:p,headers:{cookie,'idempotency-key':randomUUID()},payload:body as any});assert.equal(r.statusCode,200,r.body);return r.json();};
  async function provision(name:string){
    const d=await owner('/v1/devices',{name,platform:'other'});
    const r=await instance.app.inject({method:'POST',url:`/v1/devices/${d.id}/credential`,headers:{cookie},payload:{}});assert.equal(r.statusCode,201);
    const token=r.json().token;return {id:d.id,credentialId:r.json().credential_id,token,client:new AnyLinkClient({baseUrl,token})};
  }
  const source=await provision('SDK sender '+randomUUID()),target=await provision('SDK host '+randomUUID()),stranger=await provision('Unpaired '+randomUUID());
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'anylink-sdk-'));let worker:AnyLinkWorker|undefined;
  const grant=(enabled:boolean)=>owner('/v1/link/grants',{source_device_id:source.id,target_device_id:target.id,capability:'text.reverse',enabled});
  const input={target_device_id:target.id,capability:'text.reverse',input:{text:'AnyLink'}};
  try{
    await t.test('memory and task deployments do not require a model provider',async()=>{
      const memoryOnly=await createApp({databaseUrl:url!,ownerToken:'test-owner-secret-not-production',deepseekApiKey:'',deepseekBaseUrl:'http://127.0.0.1:1',origin:'http://127.0.0.1:3180',host:'127.0.0.1',port:3180},{logger:false});
      try{
        const ready=await memoryOnly.app.inject({url:'/readyz'});assert.equal(ready.statusCode,200);assert.equal(ready.json().provider_configured,false);
        const models=await memoryOnly.app.inject({url:'/model/v1/models',headers:{authorization:`Bearer ${source.token}`}});assert.deepEqual(models.json().data,[]);
        const call=await memoryOnly.app.inject({method:'POST',url:'/model/v1/chat/completions',headers:{authorization:`Bearer ${source.token}`},payload:{model:'deepseek-flash',messages:[{role:'user',content:'test'}]}});
        assert.equal(call.statusCode,503);assert.equal(call.json().error.code,'PROVIDER_NOT_CONFIGURED');
      }finally{await memoryOnly.app.close();}
    });
    await t.test('protocol and memory context have no harness dependency',async()=>{
      assert.equal((await source.client.protocol()).version,'1.0');assert.equal((await source.client.context()).device_id,source.id);
      const m=await source.client.saveMemory({scope:'device',applicable_device_id:source.id,title:'SDK fixture '+randomUUID(),content:'This belongs to the sender'});
      assert.equal(m.source_device_id,source.id);await source.client.deleteMemory(m.id,m.revision);
    });
    await t.test('both explicit target registration and owner grant are required',async()=>{
      assert.deepEqual((await source.client.peers()).items,[]);
      await assert.rejects(source.client.createTask(input),(e:unknown)=>e instanceof AnyLinkError&&e.status===403);
      await target.client.registerCapabilities([{name:'text.reverse',description:'Read-only text transform'}]);await grant(true);
      await assert.rejects(stranger.client.createTask(input),(e:unknown)=>e instanceof AnyLinkError&&e.status===403);
      assert.deepEqual((await stranger.client.peers()).items,[]);
      const peers=(await source.client.peers()).items;
      assert.equal(peers.length,1);assert.equal(peers[0].id,target.id);
      assert.deepEqual(peers[0].capabilities.map(c=>c.name),['text.reverse']);
      await grant(false);assert.deepEqual((await source.client.peers()).items,[]);await grant(true);
    });
    await t.test('empty polling does not grow the mutation journal and a key is consumed only on admission',async()=>{
      const key=randomUUID(),scope=target.id+':link:claim';
      const before=Number((await instance.db.query('SELECT count(*) AS n FROM mutation_keys WHERE scope=$1',[scope])).rows[0].n);
      for(let i=0;i<3;i++)assert.equal((await target.client.claimTask({idempotencyKey:key})).task,null);
      assert.equal(Number((await instance.db.query('SELECT count(*) AS n FROM mutation_keys WHERE scope=$1',[scope])).rows[0].n),before);
      const task=await source.client.createTask(input);assert.equal((await target.client.claimTask({idempotencyKey:key})).task!.id,task.id);
      await target.client.completeTask(task.id,{state:'succeeded',output:{}});
    });
    await t.test('create deduplicates and concurrent claims deliver to only one receiver',async()=>{
      const key=randomUUID(),task=await source.client.createTask(input,{idempotencyKey:key});
      assert.equal((await source.client.createTask(input,{idempotencyKey:key})).id,task.id);
      await assert.rejects(source.client.createTask({...input,input:{text:'different'}},{idempotencyKey:key}),(e:unknown)=>e instanceof AnyLinkError&&e.status===409);
      await assert.rejects(stranger.client.task(task.id),(e:unknown)=>e instanceof AnyLinkError&&e.status===404);
      const claims=await Promise.all([target.client.claimTask(),target.client.claimTask()]);assert.equal(claims.filter(c=>c.task).length,1);
      await assert.rejects(source.client.completeTask(task.id,{state:'succeeded',output:{}}),(e:unknown)=>e instanceof AnyLinkError&&e.status===404);
      const resultKey=randomUUID(),result={state:'succeeded' as const,output:{text:'kniLynA'}};
      await target.client.completeTask(task.id,result,{idempotencyKey:resultKey});
      assert.equal((await target.client.completeTask(task.id,result,{idempotencyKey:resultKey})).state,'succeeded');
      assert.equal((await source.client.task(task.id)).result!.output!.text,'kniLynA');
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
      const queued=await source.client.createTask(input);await instance.db.query("UPDATE link_tasks SET created_at=now()-interval '1 hour' WHERE id=$1",[queued.id]);
      await instance.db.query(`INSERT INTO link_tasks(id,owner_id,source_device_id,target_device_id,capability,input,state,expires_at,finished_at,source_credential_id)
        SELECT gen_random_uuid(),'00000000-0000-4000-8000-000000000001',$1,$2,'text.reverse','{}','succeeded',now()+interval '1 hour',now(),$3 FROM generate_series(1,101)`,[source.id,target.id,source.credentialId]);
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
      const policyFile=path.join(folder,'mac-policy.json');fs.writeFileSync(policyFile,JSON.stringify({device_id:target.id,roots:[{id:'workspace',label:'Test workspace',path:roots}]}));
      const macWorker=createMacLinkWorker({connection:{server:baseUrl,token:target.token,device_id:target.id},policyFile,journalPath:path.join(folder,'mac-link.sqlite')});
      try{
        await macWorker.advertise();await owner('/v1/link/grants',{source_device_id:source.id,target_device_id:target.id,capability:'files.search',enabled:true});
        const task=await source.client.createTask({target_device_id:target.id,capability:'files.search',input:{query:'anylink-report',scope:'workspace'}});
        await macWorker.runNext();const receipt=await source.client.task(task.id);
        assert.equal(receipt.state,'succeeded');assert.equal((receipt.result!.output!.matches as any[])[0].name,'anylink-report.txt');
        assert.equal(fs.readFileSync(path.join(roots,'anylink-report.txt'),'utf8'),'content must remain unchanged');
      }finally{macWorker.close();await target.client.registerCapabilities([{name:'text.reverse',description:'Read-only text transform'}]);}
    });
    await t.test('revoked grants and revoked senders stop new claims',async()=>{
      const task=await source.client.createTask(input);await grant(false);assert.equal((await target.client.claimTask()).task,null);
      await grant(true);await owner(`/v1/devices/${source.id}/revoke`,{});assert.equal((await target.client.claimTask()).task,null);
      assert.equal((await target.client.task(task.id)).state,'queued');
      const rotated=await instance.app.inject({method:'POST',url:`/v1/devices/${source.id}/credential`,headers:{cookie},payload:{}});assert.equal(rotated.statusCode,201);
      assert.equal((await target.client.claimTask()).task,null,'Issuing a new credential cannot revive tasks submitted by a revoked credential');
      const fresh=new AnyLinkClient({baseUrl,token:rotated.json().token}),next=await fresh.createTask(input);
      assert.equal((await target.client.claimTask()).task!.id,next.id);await target.client.completeTask(next.id,{state:'succeeded',output:{}});
    });
  }finally{worker?.close();await instance.app.close();fs.rmSync(folder,{recursive:true,force:true});}
});
