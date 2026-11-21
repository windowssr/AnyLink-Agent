import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {paths} from './configure.mjs';
const c=JSON.parse(fs.readFileSync(paths.connection,'utf8')),gatewayToken=fs.readFileSync(paths.gateway,'utf8').trim();
const suffix=crypto.randomBytes(4).toString('hex'),marker='AL_EDGE_'+suffix,file='anylink-proof-'+suffix+'.txt',content='Created by the native Mac OpenClaw '+suffix;
const report={started_at:new Date().toISOString(),device_id:c.device_id,checks:[],sessions:[],memories:[],files:[]};
function pass(name){report.checks.push({name,passed:true});console.log('PASS: '+name);}
async function cloud(route,method='GET',body,headers={}){
  const r=await fetch(c.server+route,{method,headers:{Authorization:`Bearer ${c.token}`,...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const data=await r.json();if(!r.ok)throw Error(`Cloud ${r.status}: ${data.error?.code}`);return data;
}
async function chat(session,message){
  const started=Date.now();const r=await fetch('http://127.0.0.1:18791/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${gatewayToken}`,'x-openclaw-session-key':session},body:JSON.stringify({model:'openclaw/default',messages:[{role:'user',content:message}],stream:true}),signal:AbortSignal.timeout(180000)});
  if(!r.ok)throw Error(`Local gateway HTTP ${r.status}`);
  const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='',text='',deltas=0,done=false;
  while(true){const {value,done:ended}=await reader.read();if(ended)break;buffer+=decoder.decode(value,{stream:true});let line;while((line=buffer.indexOf('\n'))>=0){const raw=buffer.slice(0,line).trim();buffer=buffer.slice(line+1);if(raw==='data: [DONE]')done=true;else if(raw.startsWith('data: ')){const e=JSON.parse(raw.slice(6));if(e.error)throw Error('LOCAL_AGENT_RUN_FAILED');const part=e.choices?.[0]?.delta?.content;if(part){text+=part;deltas++;}}}}
  assert.ok(done&&deltas>0,'The local Gateway did not complete a real streamed response');
  console.log(JSON.stringify({local_turn_completed:true,elapsed_ms:Date.now()-started,deltas}));return text;
}
try{
  const identity=await cloud('/edge/v1/identity');assert.equal(identity.device.id,c.device_id);pass('Mac device authenticates to cloud memory/model services');
  const session='anylink:edge-proof:'+crypto.randomUUID();report.sessions.push(session);
  const plain=await chat(session,'请只回复：边缘链路正常。');assert.ok(plain.includes('边缘链路正常'));pass('native Mac OpenClaw streams a real response through the cloud model proxy');
  const continuity=await chat(session,'我上一条让你回复的六个字是什么？');assert.ok(continuity.includes('边缘链路正常'));pass('conversation control and history stay in the local harness');
  await chat(session,`请使用你本机的文件写入工具，在工作目录新建 ${file}，内容必须精确为 ${JSON.stringify(content)}，然后用读取工具读取它并回复验证结果。不要使用 exec，不要只描述计划。`);
  assert.equal(fs.readFileSync(path.join(paths.workspace,file),'utf8'),content);report.files.push(file);pass('native local write/read tools execute on this Mac and the file postcondition matches');
  const saved=await chat(session,`请记住一条全局事实：我的本次边缘验收标识是 ${marker}。调用 anylink_memory_save 保存，主题为边缘验收-${suffix}，scope=global。`);
  const items=(await cloud('/edge/v1/memories/search','POST',{q:marker})).items;assert.equal(items.length,1);assert.equal(items[0].source_device_id,c.device_id);report.memories.push(items[0].id);pass('the local agent saves unified cloud memory with authenticated Mac provenance');
  const fresh='anylink:edge-fresh:'+crypto.randomUUID();report.sessions.push(fresh);
  const recalled=await chat(fresh,'我的本次边缘验收标识是什么？请根据当前长期记忆回答。');assert.ok(recalled.includes(marker));pass('a separate local session recalls the cloud global fact');
  const id=items[0].id,newMarker=marker+'_REV2';
  await cloud('/edge/v1/memories/'+id,'PATCH',{content:'我的本次边缘验收标识是 '+newMarker,expected_revision:1},{'Idempotency-Key':crypto.randomUUID()});
  const updated=await chat(fresh,'现在我的本次边缘验收标识是什么？请以本轮云端当前版本为准。');assert.ok(updated.includes(newMarker));pass('the next local turn receives the latest cloud revision');
  await cloud('/edge/v1/memories/'+id,'DELETE',undefined,{'Idempotency-Key':crypto.randomUUID(),'If-Match':'2'});
  assert.equal((await cloud('/edge/v1/memories/search','POST',{q:marker})).items.length,0);pass('deleted facts disappear from cloud retrieval immediately');
  report.passed=true;
}catch(e){report.passed=false;report.error=e.message;process.exitCode=1;}
finally{report.finished_at=new Date().toISOString();fs.mkdirSync(path.join(paths.root,'artifacts'),{recursive:true});fs.writeFileSync(path.join(paths.root,'artifacts/edge-acceptance-'+suffix+'.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,report:'artifacts/edge-acceptance-'+suffix+'.json',error:report.error}));}
