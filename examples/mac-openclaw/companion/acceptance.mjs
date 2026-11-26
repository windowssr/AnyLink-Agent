import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

// A real, isolated local conversation. No memory writes, computer tools or
// external messages are requested; the renderer itself never calls a model.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const diagnostic=path.join(root,'data/mac/desktop/companion-state.json');
const read=()=>JSON.parse(fs.readFileSync(diagnostic,'utf8'));
const initial=read();
assert.equal(initial.visible,true,'Open the desktop companion first');
assert.equal(initial.renderer,'ready');
assert.equal(initial.active_sessions,0,'Wait for current local tasks to finish');
assert.ok(Date.now()/1000-initial.updated_at<12,'Desktop diagnostic is stale');
const token=fs.readFileSync(path.join(root,'secrets/mac-gateway-token'),'utf8').trim();
const report={started_at:new Date().toISOString(),session:'anylink:companion-proof:'+randomUUID(),states:[],deltas:0,passed:false};
let sampling=true;
const observe=(async()=>{
  while(sampling){
    const value=read(),key=value.mood+':'+value.agent_state;
    if(report.states.at(-1)?.key!==key)report.states.push({key,mood:value.mood,agent_state:value.agent_state,active_sessions:value.active_sessions});
    await new Promise(resolve=>setTimeout(resolve,250));
  }
})();
try{
  const response=await fetch('http://127.0.0.1:18791/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,'x-openclaw-session-key':report.session},body:JSON.stringify({model:'openclaw/default',messages:[{role:'user',content:'这是一次桌面伙伴状态验收。不要使用任何工具，不要保存记忆，不要操作软件或发送消息。请连续写一篇约900字的中文短文，介绍桌面虚拟伙伴如何安静陪伴用户工作。直接给出文章正文。'}],stream:true}),signal:AbortSignal.timeout(180000)});
  assert.equal(response.status,200);
  let buffer='',done=false;const decoder=new TextDecoder();
  for await(const chunk of response.body){
    buffer+=decoder.decode(chunk,{stream:true});let next;
    while((next=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,next).trim();buffer=buffer.slice(next+1);
      if(line==='data: [DONE]')done=true;
      else if(line.startsWith('data: ')){const value=JSON.parse(line.slice(6));assert.ok(!value.error,'Local model stream failed');if(value.choices?.[0]?.delta?.content)report.deltas++;}
    }
  }
  assert.ok(done&&report.deltas>0,'No real streamed response');
  await new Promise(resolve=>setTimeout(resolve,11500));
  assert.ok(report.states.some(value=>value.agent_state==='working'&&value.active_sessions>0),'No active task projection observed');
  assert.ok(report.states.some(value=>value.mood==='finished'),'No end-of-run projection observed');
  assert.equal(read().agent_state,'idle');
  report.passed=true;
}catch(error){report.error=error.message;process.exitCode=1;}
finally{
  sampling=false;await observe;report.finished_at=new Date().toISOString();
  fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});
  fs.writeFileSync(path.join(root,'artifacts/desktop-companion-acceptance.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({passed:report.passed,deltas:report.deltas,states:report.states,error:report.error}));
}
