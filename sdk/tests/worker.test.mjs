import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {AnyLinkWorker} from '../src/worker.mjs';
test('a durable started receipt is unknown after restart and never re-executes',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'anylink-recovery-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 const file=path.join(folder,'receipt.sqlite'),db=new DatabaseSync(file);
 db.exec("CREATE TABLE executions(task_id TEXT PRIMARY KEY,state TEXT NOT NULL,result TEXT); INSERT INTO executions VALUES('task-1','started',NULL)");db.close();let calls=0;
 const task={id:'task-1',state:'running',capability:'text.reverse',input:{}};
 const worker=new AnyLinkWorker({journalPath:file,client:{baseUrl:'https://fixture.test/',identity:async()=>({device:{id:'target-1'}}),claimTask:async()=>({task}),task:async()=>task},handlers:{'text.reverse':{description:'fixture',async execute(){calls++;return {};}}}});
 try{const r=await worker.runNext();assert.equal(r.execution_unknown,true);assert.equal(calls,0);assert.deepEqual(await worker.recoverResults(),[]);assert.equal(fs.statSync(file).mode&0o777,0o600);}finally{worker.close();}
});
test('a journal cannot send receipts to another service or device',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'anylink-binding-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));const file=path.join(folder,'receipt.sqlite');let claims=0;
 const client={baseUrl:'https://first.test/',identity:async()=>({device:{id:'target-1'}}),claimTask:async()=>{claims++;return {task:null};}};
 const first=new AnyLinkWorker({client,journalPath:file,handlers:{}});await first.runNext();first.close();
 for(const altered of [{...client,baseUrl:'https://second.test/'},{...client,identity:async()=>({device:{id:'target-2'}})}]){
  const next=new AnyLinkWorker({client:altered,journalPath:file,handlers:{}});try{await assert.rejects(next.runNext(),/another service or device/);}finally{next.close();}
 }
 assert.equal(claims,1);
});
test('a handler exception cannot prove that external effects failed',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'anylink-effect-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));let calls=0;
 let task={id:'effect-task',state:'running',capability:'text.reverse',input:{}};
 const client={baseUrl:'https://fixture.test/',identity:async()=>({device:{id:'target'}}),claimTask:async()=>({task}),task:async()=>task,completeTask:async(_id,result)=>task={...task,...result}};
 const worker=new AnyLinkWorker({client,journalPath:path.join(folder,'journal.sqlite'),handlers:{'text.reverse':{description:'fixture',async execute(){calls++;throw new Error('Connection broke after an external effect');}}}});
 try{assert.equal((await worker.runNext()).task.state,'unknown');await worker.runNext();assert.equal(calls,1);}finally{worker.close();}
});
test('startup identity transport failure can recover without claiming or replaying early',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'anylink-startup-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));let identities=0,claims=0,effects=0;
 let task={id:'after-connect',state:'running',capability:'text.reverse',input:{}};
 const client={baseUrl:'https://fixture.test/',identity:async()=>{if(++identities===1)throw new Error('Tunnel not ready');return {device:{id:'target'}};},claimTask:async()=>{claims++;return {task};},task:async()=>task,completeTask:async(_id,result)=>task={...task,...result}};
 const worker=new AnyLinkWorker({client,journalPath:path.join(folder,'journal.sqlite'),handlers:{'text.reverse':{description:'fixture',async execute(){effects++;return {text:'done'};}}}});
 try{
  await assert.rejects(worker.runNext(),/Tunnel not ready/);assert.equal(claims,0);assert.equal(effects,0);
  assert.equal((await worker.runNext()).task.state,'succeeded');assert.equal(identities,2);assert.equal(effects,1);
  await worker.runNext();assert.equal(effects,1);
 }finally{worker.close();}
});
