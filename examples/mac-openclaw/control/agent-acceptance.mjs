import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {projectRoot,controlStatus} from './client.mjs';

// Real model + local harness acceptance. Creates only its own new document.
const profile=JSON.parse(fs.readFileSync(path.join(projectRoot,'data/mac/openclaw/openclaw.json'),'utf8'));
const token=fs.readFileSync(path.join(projectRoot,'secrets/mac-gateway-token'),'utf8').trim();
const run='mac-agent-proof-'+randomBytes(4).toString('hex'),file=run+'.txt';
const full=path.join(profile.agents.defaults.workspace,file),expected=`AnyLink Agent GUI verified ${run}\n中文输入准确。\n`;
const report={run,file,session:'anylink:'+run+':'+randomUUID(),expected,started_at:new Date().toISOString()};
try{
  const deadline=Date.now()+60000;let healthy=false;
  while(Date.now()<deadline){try{healthy=(await fetch('http://127.0.0.1:18791/healthz',{signal:AbortSignal.timeout(2000)})).ok;}catch{}if(healthy)break;await new Promise(r=>setTimeout(r,1000));}
  if(!healthy)throw new Error('Local Gateway is not healthy.');
  if(!(await controlStatus()).ready)throw new Error('Mac control is not ready.');
  fs.writeFileSync(full,'Awaiting GUI acceptance\n',{flag:'wx',mode:0o600});
  fs.writeFileSync(path.join(projectRoot,'artifacts',run+'-context.json'),JSON.stringify(report,null,2)+'\n');
  const message=`请现在完成一次真实 Mac GUI 验收。工作区现有文件 ${file} 已由测试程序创建并确认存在，不需要检查路径。只用 anylink_mac_* 工具打开文本编辑 com.apple.TextEdit 的这个工作区文件，观察、聚焦、点击编辑区，替换全文为 ${JSON.stringify(expected)}，然后 Cmd+S 保存。type 必须 clear=true、foreground=true，以验证中英文剪贴板输入。每次动作使用最新观察。不使用 exec、write、edit 或 shell，也不需要列出工作区；最终可以 read 核对。此次用户明确授权只操作这个新测试文档，包括切换桌面、点击、替换和保存；不要写长时记忆。完成后报告实际结果，不要只给计划。`;
  const response=await fetch('http://127.0.0.1:18791/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','x-openclaw-session-key':report.session},body:JSON.stringify({model:'openclaw/default',messages:[{role:'user',content:message}],stream:true}),signal:AbortSignal.timeout(300000)});
  if(!response.ok)throw new Error('Gateway HTTP '+response.status);
  let buffer='',reply='',completed=false;const decoder=new TextDecoder();
  for await(const chunk of response.body){
    buffer+=decoder.decode(chunk,{stream:true});let index;
    while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(line==='data: [DONE]')completed=true;else if(line.startsWith('data: ')){const event=JSON.parse(line.slice(6));if(event.error)throw new Error('LOCAL_AGENT_RUN_FAILED');reply+=event.choices?.[0]?.delta?.content??'';}}
  }
  report.reply=reply;report.actual=fs.readFileSync(full,'utf8');report.exact_match=report.actual===expected;
  report.passed=completed&&report.actual.trimEnd()===expected.trimEnd();
  if(!report.passed)throw new Error('GUI document postcondition did not match.');
}catch(error){report.passed=false;report.error=error.message;process.exitCode=1;}
finally{
  report.finished_at=new Date().toISOString();fs.writeFileSync(path.join(projectRoot,'artifacts',run+'-result.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({run,file,passed:report.passed,exact_match:report.exact_match,error:report.error}));
}
