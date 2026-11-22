import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {root,node,output} from './layout.mjs';
import {previewAgent} from './configuration.mjs';
const exec=promisify(execFile),marker='AL_NATIVE_'+randomUUID();
const c=JSON.parse(fs.readFileSync(path.join(root,'secrets/android-preview-connection.json')));
const mac=JSON.parse(fs.readFileSync(path.join(root,'secrets/mac-connection.json')));
const token=fs.readFileSync(path.join(root,'secrets/mac-gateway-token'),'utf8').trim();
const session='agent:'+previewAgent+':native-proof-'+randomUUID();
const file=path.join(root,'data/mac/workspace',marker+'.txt'),memories=[];
let createdFile=false;
const speechOnly=process.argv.includes('--speech-only');
const report={started_at:new Date().toISOString(),session,scope:speechOnly?'speech':'full',logical_preview_only:true,upstream:'2026.11.6',checks:[],turns:[]};
const pass=name=>{report.checks.push(name);console.log('PASS '+name);};
async function cloud(connection,route,method='GET',body,headers={}){
  const r=await fetch(connection.server+route,{method,headers:{Authorization:'Bearer '+connection.token,...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
  const data=await r.json();if(!r.ok)throw new Error('CLOUD_'+r.status+'_'+(data.error?.code??'ERROR'));return data;
}
async function rpc(method,params={}){
  const {stdout}=await exec(node,[path.join(root,'mac/cli.mjs'),'gateway','call',method,'--params',JSON.stringify(params),'--timeout','45000','--json'],{cwd:root,timeout:60000,maxBuffer:4*1024*1024});
  return JSON.parse(stdout);
}
async function chat(key,prompt){
  const start=Date.now();let first,reply='',buffer='',done=false,deltas=0;
  const r=await fetch('http://127.0.0.1:18791/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','x-openclaw-agent-id':previewAgent,'x-openclaw-session-key':key},body:JSON.stringify({model:'openclaw/default',stream:true,messages:[{role:'user',content:prompt}]}),signal:AbortSignal.timeout(240000)});
  if(!r.ok)throw new Error('GATEWAY_'+r.status);
  const decoder=new TextDecoder();for await(const chunk of r.body){buffer+=decoder.decode(chunk,{stream:true});let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(line==='data: [DONE]')done=true;else if(line.startsWith('data: ')){const e=JSON.parse(line.slice(6));if(e.error)throw new Error('AGENT_RUN_FAILED');const text=e.choices?.[0]?.delta?.content;if(text){first??=Date.now();reply+=text;deltas++;}}}}
  assert.ok(done&&deltas>0);report.turns.push({elapsed_ms:Date.now()-start,first_text_ms:first-start,deltas});return reply;
}
try{
  fs.mkdirSync(output,{recursive:true});
  if(!speechOnly){
  const context=await cloud(c,'/edge/v1/context');assert.equal(context.device_id,c.device_id);assert.notEqual(c.device_id,mac.device_id);
  pass('Android preview has its separately authorized cloud identity');
  const reply=await chat(session,'不要调用工具或写记忆。请只输出本轮上下文中的当前逻辑设备ID。');
  assert.ok(reply.includes(c.device_id));assert.ok(!reply.includes(mac.device_id));
  pass('Mac-hosted Android agent streams through DeepSeek with Android memory context');
  fs.writeFileSync(file,'Native Android read-only search proof\n',{flag:'wx',mode:0o600});
  createdFile=true;
  await chat(session,`请只用 anylink_mac_search_files，在 workspace 范围按文件名查找 ${marker}，报告实际结果。不要读取内容、写文件、操作软件或保存记忆。`);
  const history=await rpc('chat.history',{sessionKey:session,limit:100});
  // OpenClaw's dispatch surface stores the concrete tool receipt inside its
  // typed custom activity record, as well as the parent dispatch_action result.
  const results=(history.messages??[]).flatMap(m=>[m,...(m.role==='custom'&&Array.isArray(m.content)?m.content:[])]).filter(m=>m.role==='toolResult'&&m.toolName==='anylink_mac_search_files'&&!m.isError);
  assert.ok(results.some(m=>JSON.stringify(m).includes(file)),'Real search tool receipt missing');
  assert.equal(fs.readFileSync(file,'utf8'),'Native Android read-only search proof\n');
  pass('Same Android session executes the existing read-only Mac search and returns a real receipt');
  await chat(session,`请记住两条本次验收事实，分别调用 anylink_memory_save：global，标题 ${marker}_GLOBAL，内容“本次手机原生验收的全局标记是 ${marker}_G”；device，标题 ${marker}_DEVICE，内容“本次手机原生验收的设备标记是 ${marker}_D”。不设置其他适用设备，不写本地记忆文件。`);
  const found=(await cloud(c,'/edge/v1/memories/search','POST',{q:marker})).items;
  for(const m of found)if(m.source_device_id===c.device_id&&m.title?.startsWith(marker))memories.push(m);
  assert.equal(memories.length,2);assert.ok(memories.some(m=>m.scope==='global'));assert.ok(memories.some(m=>m.scope==='device'&&m.applicable_device_id===c.device_id));
  const macContext=await cloud(mac,'/edge/v1/context');
  assert.ok(macContext.global.some(m=>m.title===marker+'_GLOBAL'));
  assert.ok(!macContext.device.some(m=>m.title===marker+'_DEVICE'));
  pass('Explicit memory tools persist global and Android-device facts with Android provenance');
  const fresh=await chat('agent:'+previewAgent+':native-fresh-'+randomUUID(),`本次手机原生验收的全局标记和设备标记分别是什么？请根据本轮云端有效事实回答，不调用写入工具。`);
  assert.ok(fresh.includes(marker+'_G')&&fresh.includes(marker+'_D'));
  pass('A fresh Android conversation recalls both scopes while Mac device scope remains isolated');
  }
  const config=await rpc('talk.config',{});assert.equal(config.config?.talk?.realtime?.mode??config.talk?.realtime?.mode,'stt-tts');
  const audio=await rpc('talk.speak',{text:'主人，我在呢。我们一起把事情做好吧！'});
  const bytes=Buffer.from(audio.audioBase64??'','base64');assert.ok(bytes.length>1000);assert.equal(audio.provider,'microsoft');
  assert.equal(audio.mimeType,'audio/mpeg');assert.equal(audio.outputFormat,'audio-24khz-48kbitrate-mono-mp3');
  fs.writeFileSync(path.join(output,'native-gateway-speech.mp3'),bytes,{mode:0o600});
  report.speech={bytes:bytes.length,mime_type:audio.mimeType,provider:audio.provider};
  pass('Official talk.speak returns real configured Microsoft neural audio');
  report.passed=true;
}catch(error){report.passed=false;report.error=error.message;process.exitCode=1;}
finally{
  // Remove only this run's uniquely named records, preserving all user facts.
  try{if(!speechOnly){
    const found=(await cloud(c,'/edge/v1/memories/search','POST',{q:marker})).items;
    for(const m of found)if(m.source_device_id===c.device_id&&m.title?.startsWith(marker))await cloud(c,'/edge/v1/memories/'+m.id,'DELETE',undefined,{'Idempotency-Key':randomUUID(),'If-Match':String(m.revision)});
    report.test_memories_remaining=(await cloud(c,'/edge/v1/memories/search','POST',{q:marker})).items.filter(m=>m.title?.startsWith(marker)).length;
  }
  }catch{report.cleanup_error=true;process.exitCode=1;}
  if(createdFile&&fs.existsSync(file))fs.unlinkSync(file);
  report.finished_at=new Date().toISOString();fs.writeFileSync(path.join(output,speechOnly?'speech-acceptance.json':'acceptance.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,error:report.error,cleanup_error:report.cleanup_error}));
}
