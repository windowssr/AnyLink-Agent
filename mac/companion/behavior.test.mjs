import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import plugin,{createBridge,projectToolResult} from './plugin/index.mjs';
import {classify,cleanSpeech} from './behavior.mjs';

test('chat tone and speech cleaning handle comfort, celebrations and code',()=>{
  assert.equal(classify('今天心情不好，有点累了').emotion,'comfort');
  assert.equal(classify('恭喜，你考试通过了！').emotion,'excited');
  assert.equal(classify('为什么尾巴会动？').gesture,'point');
  assert.equal(cleanSpeech('你好。```js\nconsole.log(123)\n``` [详情](https://example.com)'),'你好。 详情');
});
test('native result projection accepts typed search receipts, excludes arbitrary tool output and bounds paths',()=>{
  assert.deepEqual(projectToolResult({toolName:'exec',result:{content:[{text:'secret output'}]}}),{toolName:'exec',toolCallId:'',failed:false});
  const event={toolName:'anylink_mac_search_files',toolCallId:'one',result:{details:{query:'proof',read_only:true,name_only:true,partial:true,matches:[{name:'proof.txt',path:'/tmp/proof.txt'},{name:'bad',path:'relative.txt'}]}}};
  const result=projectToolResult(event);assert.equal(result.search.matches.length,1);assert.equal(result.search.partial,true);
  assert.equal(projectToolResult({...event,error:'failed'}).search,undefined);
  assert.equal(projectToolResult({...event,result:{content:[{text:JSON.stringify(event.result.details)}]}}).search,undefined,'Model text is not evidence');
  event.result.details.matches=Array.from({length:50},(_,i)=>({name:'long'+i,path:'/'+('a'.repeat(2000))+i}));
  const bounded=projectToolResult(event);assert.ok(Buffer.byteLength(JSON.stringify(bounded))<=18000);assert.ok(bounded.search.matches.length<30);
});
test('desktop projection requires a finite live lease, isolates channels and prunes expired text',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'anylink-companion-'));let time=1000000;
  try{
    const folder=path.join(root,'data/mac/companion');fs.mkdirSync(folder,{recursive:true});const bridge=createBridge(root,()=>time),ctx={agentId:'main',sessionId:'local'};
    assert.equal(bridge.emit('reply',ctx,{text:'hello'}),false);
    const lease=value=>fs.writeFileSync(path.join(folder,'presence.json'),JSON.stringify(value));
    lease({enabled:true,expires_at:'invalid'});assert.equal(bridge.emit('reply',ctx),false);
    lease({enabled:true,expires_at:time+30000});assert.equal(bridge.emit('reply',{...ctx,channel:'slack'}),false);
    assert.equal(bridge.emit('reply',ctx,{text:'hello'}),true);
    const file=fs.readdirSync(path.join(folder,'events'))[0];assert.equal(fs.statSync(path.join(folder,'events',file)).mode&0o777,0o600);
    time+=130000;bridge.prune();assert.equal(fs.readdirSync(path.join(folder,'events')).length,0);
    assert.equal(bridge.emit('reply',ctx),false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('companion can express and stroll but cannot change owner preferences or execute tasks',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'anylink-companion-plugin-'));
  try{
    fs.mkdirSync(path.join(root,'mac/companion'),{recursive:true});fs.writeFileSync(path.join(root,'mac/companion/persona.md'),'fixture persona');
    const callbacks={},factories=[];
    plugin.register({pluginConfig:{projectRoot:root},on:(name,handler)=>callbacks[name]=handler,registerTool:fn=>factories.push(fn)});
    const ctx={agentId:'companion',sessionKey:'test',sessionId:'fixture',runId:'turn'};
    assert.deepEqual(callbacks.before_prompt_build({currentUserMessage:'你好'},ctx).toolsAllow,['anylink_companion_expression','anylink_companion_control']);
    assert.equal(callbacks.before_tool_call({toolName:'exec'},ctx).block,true);
    assert.equal(callbacks.before_tool_call({toolName:'anylink_memory_save'},ctx).block,true);
    assert.equal(callbacks.before_tool_call({toolName:'anylink_companion_expression'},ctx),undefined);
    assert.equal(callbacks.before_tool_call({toolName:'anylink_companion_control',params:{action:'walk'}},ctx),undefined);
    assert.equal(callbacks.before_tool_call({toolName:'anylink_companion_control',params:{action:'quiet',minutes:0}},ctx).block,true);
    assert.equal(callbacks.before_tool_call({toolName:'exec'},{agentId:'main'}),undefined);
    const tool=factories[0](ctx);await assert.rejects(tool.execute('bad',{emotion:'run_command',gesture:'rm'}));
    await assert.rejects(factories[1](ctx).execute('bad',{action:'configure',read_aloud:true}));
    callbacks.llm_output({assistantTexts:['Do not read an interrupted answer']},ctx);
    callbacks.agent_end({success:false,messages:[]},ctx);
    assert.equal(fs.existsSync(path.join(root,'data/mac/companion/events')),false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
