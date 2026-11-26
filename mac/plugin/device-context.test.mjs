import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import plugin,{memoryIntent} from './index.mjs';

const MAC='11111111-1111-4111-8111-111111111111',ANDROID='22222222-2222-4222-8222-222222222222';
const GLOBAL={id:'g',title:'共同偏好',content:'Shared global fact',scope:'global',applicable_device_id:null,revision:2};
const MAC_FACT={id:'m',title:'Mac 路径',content:'Mac-only fact',scope:'device',applicable_device_id:MAC,revision:3};
const ANDROID_FACT={id:'a',title:'Android 偏好',content:'Android-only fact',scope:'device',applicable_device_id:ANDROID,revision:4};
const androidContext={runId:'android-run',agentId:'anylink-android-preview',sessionKey:'agent:anylink-android-preview:node-123456789abc'};
const macContext={runId:'mac-run',agentId:'main',sessionKey:'agent:main:anylink:desktop:fixture'};
const value={title:'偏好',content:'以后先给文件路径',scope:'device'};

async function fixture(run,{routeFileMissing=false,onRequest}={}){
  const directory=await mkdtemp(join(tmpdir(),'anylink-device-context-')),macFile=join(directory,'mac.json'),androidFile=join(directory,'android.json');
  await writeFile(macFile,JSON.stringify({server:'http://fixture',token:'ak_fixture_mac',device_id:MAC}));
  if(!routeFileMissing)await writeFile(androidFile,JSON.stringify({server:'http://fixture',token:'ak_fixture_android',device_id:ANDROID}));
  const original=globalThis.fetch,hooks={},requests=[];let factory;
  globalThis.fetch=async(url,options)=>{
    const entry={path:new URL(url).pathname,method:options.method,token:options.headers.Authorization,headers:options.headers,body:options.body===undefined?undefined:JSON.parse(options.body)};
    requests.push(entry);
    const override=await onRequest?.(entry);if(override!==undefined)return override;
    if(entry.path==='/edge/v1/memory/assemble')return Response.json({error:{code:'NOT_FOUND'}},{status:404});
    if(entry.path==='/edge/v1/context')return Response.json({device_id:entry.token==='Bearer ak_fixture_android'?ANDROID:MAC,global:[GLOBAL],device:[entry.token==='Bearer ak_fixture_android'?ANDROID_FACT:MAC_FACT]});
    if(entry.path==='/edge/v1/memories/search')return Response.json({items:[GLOBAL,MAC_FACT,ANDROID_FACT]});
    return Response.json({id:'saved',revision:entry.body?.expected_revision===undefined?1:entry.body.expected_revision+1});
  };
  try{
    plugin.register({pluginConfig:{connectionFile:macFile,deviceConnections:{'anylink-android-preview':{connectionFile:androidFile,label:'Android 开发预览（未绑定真机）',platform:'android'}}},on:(name,callback)=>hooks[name]=callback,registerTool:callback=>factory=callback});
    const tools=ctx=>Object.fromEntries(factory(ctx).map(tool=>[tool.name,tool]));
    await run({hooks,requests,tools});
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
}

test('interleaved registered Mac and Android runs keep facts, credentials and write targets separate',async()=>{
  let releaseMac;const heldMac=new Promise(resolve=>releaseMac=resolve);
  await fixture(async({hooks,requests,tools})=>{
    const macPrompt=hooks.before_prompt_build({currentUserMessage:'记住我喜欢简短回复'},macContext);
    const androidPrompt=await hooks.before_prompt_build({currentUserMessage:'记住先给路径'},androidContext);
    assert.match(androidPrompt.prependContext,/Android-only fact/);assert.doesNotMatch(androidPrompt.prependContext,/Mac-only fact/);
    assert.match(androidPrompt.prependSystemContext,/Gateway 在 Mac/);assert.match(androidPrompt.prependSystemContext,/不证明本轮物理输入来自手机/);
    const androidSave=tools(androidContext).anylink_memory_save;
    assert.equal((await androidSave.execute('phone-save',value)).details.id,'saved');
    const phoneWrite=requests.at(-1);assert.equal(phoneWrite.token,'Bearer ak_fixture_android');assert.equal(phoneWrite.body.applicable_device_id,ANDROID);
    releaseMac();const mac=await macPrompt;
    assert.match(mac.prependContext,/Mac-only fact/);assert.doesNotMatch(mac.prependContext,/Android-only fact/);
    await tools(macContext).anylink_memory_save.execute('mac-save',value);
    assert.equal(requests.at(-1).token,'Bearer ak_fixture_mac');assert.equal(requests.at(-1).body.applicable_device_id,MAC);
    await androidSave.execute('phone-save-after-mac',{...value,scope:'global'});
    assert.equal(requests.at(-1).token,'Bearer ak_fixture_android');assert.equal(requests.at(-1).body.applicable_device_id,null);
  },{onRequest:async entry=>{if(entry.path==='/edge/v1/context'&&entry.token==='Bearer ak_fixture_mac')await heldMac;}});
});

test('unmapped Android and node sessions inject/search only global facts and reject every write',async()=>{
  await fixture(async({hooks,requests,tools})=>{
    for(const ctx of [
      {runId:'unmapped',agentId:'anylink-android-unconfigured'},
      {runId:'unmapped-short',agentId:'android-unconfigured'},
      {runId:'unmapped-native',agentId:'main',sessionKey:'agent:main:node-abcdef123456'},
    ]){
      const prompt=await hooks.before_prompt_build({currentUserMessage:'记住这个偏好'},ctx);
      assert.match(prompt.prependContext,/Shared global fact/);assert.doesNotMatch(prompt.prependContext,/Mac-only fact|Android-only fact/);
      assert.deepEqual(requests.at(-1).body,{scope:'global'});
      const registered=tools(ctx),before=requests.length;
      for(const name of ['anylink_memory_save','anylink_memory_update','anylink_memory_delete'])assert.equal((await registered[name].execute(name,{...value,id:'fact',expected_revision:1})).details.error.code,'DEVICE_CONTEXT_UNCONFIGURED');
      assert.equal(requests.length,before,'An unbound route must never write as Mac');
      const found=await registered.anylink_memory_search.execute('search',{q:'fact'});
      assert.deepEqual(found.details.items,[GLOBAL]);assert.deepEqual(requests.at(-1).body,{q:'fact',scope:'global'});
      const count=requests.length;
      assert.equal((await registered.anylink_memory_search.execute('targeted-search',{device_id:MAC})).details.error.code,'DEVICE_CONTEXT_UNCONFIGURED');
      assert.equal(requests.length,count);
    }
  });
});

test('a configured route with an unavailable credential file never inherits Mac device context',async()=>{
  await fixture(async({hooks,requests,tools})=>{
    const prompt=await hooks.before_prompt_build({currentUserMessage:'请记住这个'},androidContext);
    assert.match(prompt.prependContext,/Shared global fact/);assert.doesNotMatch(prompt.prependContext,/Mac-only fact|Android-only fact/);
    const before=requests.length;
    assert.equal((await tools(androidContext).anylink_memory_save.execute('missing',value)).details.error.code,'DEVICE_CONTEXT_UNCONFIGURED');
    assert.equal(requests.length,before);
  },{routeFileMissing:true});
});

test('the configured cloud identity must match before facts or writes are accepted',async()=>{
  await fixture(async({hooks,requests,tools})=>{
    const prompt=await hooks.before_prompt_build({currentUserMessage:'请记住这个'},androidContext);
    assert.doesNotMatch(prompt.prependContext,/Mac-only fact|Android-only fact/);assert.match(prompt.prependContext,/上下文未确认/);assert.match(prompt.prependContext,/Shared global fact/);
    const before=requests.length;
    assert.equal((await tools(androidContext).anylink_memory_save.execute('mismatch',value)).details.error.code,'DEVICE_CONTEXT_UNVERIFIED');
    assert.equal(requests.length,before);
    assert.deepEqual((await tools(androidContext).anylink_memory_search.execute('mismatch-search',{})).details.items,[GLOBAL]);
  },{onRequest:entry=>entry.path==='/edge/v1/context'&&entry.token==='Bearer ak_fixture_android'?Response.json({device_id:MAC,global:[GLOBAL],device:[MAC_FACT]}):undefined});
});

test('a revoked Android credential degrades to a bounded global-only read and cannot write as Mac',async()=>{
  await fixture(async({hooks,requests,tools})=>{
    const prompt=await hooks.before_prompt_build({currentUserMessage:'请记住这个'},androidContext);
    assert.match(prompt.prependContext,/Shared global fact/);assert.doesNotMatch(prompt.prependContext,/Mac-only fact|Android-only fact/);
    assert.equal(requests.length,3);assert.equal(requests[0].token,'Bearer ak_fixture_android');assert.equal(requests[2].token,'Bearer ak_fixture_mac');assert.deepEqual(requests[2].body,{scope:'global'});
    const before=requests.length;
    assert.equal((await tools(androidContext).anylink_memory_save.execute('revoked',value)).details.error.code,'DEVICE_CONTEXT_UNVERIFIED');
    assert.equal(requests.length,before);
  },{onRequest:entry=>entry.token==='Bearer ak_fixture_android'?Response.json({error:{code:'EDGE_AUTH_REQUIRED'}},{status:401}):undefined});
});

test('Android writes reject a different device target and preserve revisions and stable idempotency',async()=>{
  await fixture(async({hooks,requests,tools})=>{
    await hooks.before_prompt_build({currentUserMessage:'请记住并更正我的偏好'},androidContext);
    const registered=tools(androidContext),before=requests.length;
    assert.equal((await registered.anylink_memory_save.execute('wrong-device',{...value,applicable_device_id:MAC})).details.error.code,'DEVICE_CONTEXT_MISMATCH');
    assert.equal(requests.length,before);
    await registered.anylink_memory_save.execute('same-write',value);const first=requests.at(-1).headers['Idempotency-Key'];
    await registered.anylink_memory_save.execute('same-write',value);assert.equal(requests.at(-1).headers['Idempotency-Key'],first);
    await registered.anylink_memory_update.execute('revision',{id:'fact-id',content:'新偏好',expected_revision:4});
    assert.deepEqual(requests.at(-1).body,{content:'新偏好',expected_revision:4});assert.equal(requests.at(-1).token,'Bearer ak_fixture_android');
    await registered.anylink_memory_delete.execute('delete-revision',{id:'fact-id',expected_revision:5});
    assert.equal(requests.at(-1).headers['If-Match'],'5');assert.equal(requests.at(-1).body,undefined);
  });
});

test('mapped Android search defaults to current global and device facts with fresh identity validation',async()=>{
  let changed=false;
  await fixture(async({hooks,requests,tools})=>{
    await hooks.before_prompt_build({currentUserMessage:'你记得什么'},androidContext);
    const search=tools(androidContext).anylink_memory_search;
    const current=await search.execute('current',{});assert.deepEqual(current.details.items,[GLOBAL,ANDROID_FACT]);
    const filtered=await search.execute('filtered',{q:'Android'});assert.deepEqual(filtered.details.items,[ANDROID_FACT]);
    assert.equal(requests.at(-1).token,'Bearer ak_fixture_android');
    changed=true;
    assert.equal((await search.execute('drift',{})).details.error.code,'DEVICE_CONTEXT_MISMATCH');
  },{onRequest:entry=>changed&&entry.path==='/edge/v1/context'?Response.json({device_id:MAC,global:[GLOBAL],device:[MAC_FACT]}):undefined});
});

test('memory intent is current-turn only, honors negation and expires at agent_end',async()=>{
  for(const text of ['不要保存这条记忆','别删除记忆','不记住这个','do not forget this','不要更正记忆'])assert.equal(memoryIntent(text),false,text);
  await fixture(async({hooks,requests,tools})=>{
    const ctx={...androidContext,runId:'intent'},save=tools(ctx).anylink_memory_save;
    await hooks.before_prompt_build({currentUserMessage:'',prompt:'历史里说过记住'},ctx);
    const before=requests.length;assert.equal((await save.execute('not-current',value)).details.error.code,'EXPLICIT_MEMORY_INTENT_REQUIRED');assert.equal(requests.length,before);
    await hooks.before_prompt_build({currentUserMessage:'请记住当前偏好'},ctx);
    assert.equal((await save.execute('explicit',value)).details.id,'saved');
    hooks.agent_end({},ctx);assert.equal((await save.execute('late',value)).details.error.code,'EXPLICIT_MEMORY_INTENT_REQUIRED');
  });
});

test('unknown writes are not replayed or followed by another write in the same run',async()=>{
  let fail=true;
  await fixture(async({hooks,requests,tools})=>{
    await hooks.before_prompt_build({currentUserMessage:'请记住这个偏好'},androidContext);
    const registered=tools(androidContext);
    const unknown=await registered.anylink_memory_save.execute('unknown',value);
    assert.equal(unknown.details.error.code,'MEMORY_RESULT_UNKNOWN');assert.equal(unknown.isError,true);
    fail=false;
    await hooks.before_prompt_build({currentUserMessage:'请记住这个偏好'},androidContext);
    const count=requests.length;
    assert.equal((await registered.anylink_memory_save.execute('new-write',value)).details.error.code,'MEMORY_RESULT_UNKNOWN');assert.equal(requests.length,count);
    assert.deepEqual((await registered.anylink_memory_search.execute('reconcile',{})).details.items,[GLOBAL,ANDROID_FACT]);
    hooks.agent_end({},androidContext);
    const next={...androidContext,runId:'next-explicit'};
    await hooks.before_prompt_build({currentUserMessage:'确认后请记住这个新偏好'},next);
    assert.equal((await tools(next).anylink_memory_save.execute('new-explicit',value)).details.id,'saved');
  },{onRequest:entry=>{if(fail&&entry.method==='POST'&&entry.path==='/edge/v1/memories')throw new TypeError('fixture network disconnected');}});
});

test('agent-tier facts join the prompt context and carry agent scope',async()=>{
  const AGENT_FACT={id:'agent-fact',title:'Agent 私有',content:'Only this agent sees me',scope:'agent',applicable_device_id:MAC,applicable_agent_id:'agent-1',revision:1};
  await fixture(async({hooks,requests})=>{
    const prompt=await hooks.before_prompt_build({currentUserMessage:'你好'},macContext);
    assert.match(prompt.prependContext,/Only this agent sees me/);assert.match(prompt.prependContext,/Agent 私有/);
    assert.match(prompt.prependSystemContext,/agent（当前 Agent）/);
    const save=requests.find(r=>r.path==='/edge/v1/memories');
    assert.equal(save,undefined);
  },{onRequest:entry=>entry.path==='/edge/v1/context'?Response.json({device_id:MAC,global:[GLOBAL],device:[MAC_FACT],agent:[AGENT_FACT]}):undefined});
});

test('link tools support main invoke, remote read-only directory/status, target_device_slug and idempotency',async()=>{
  await fixture(async({hooks,requests,tools})=>{
    await hooks.before_prompt_build({currentUserMessage:'派发一个任务'},macContext);
    const registered=tools(macContext);
    for(const name of ['anylink_link_directory','anylink_invoke','anylink_task_create','anylink_task_status','anylink_task_cancel'])assert.ok(registered[name],name);
    assert.equal(tools(androidContext).anylink_task_create,undefined,'write link tools stay off non-main agents');
    const remoteTools=tools({runId:'remote-run',agentId:'remote'});
    assert.ok(remoteTools.anylink_link_directory&&remoteTools.anylink_task_status,'remote agent gets read-only link tools');
    assert.equal(remoteTools.anylink_invoke,undefined,'remote agent cannot dispatch outbound tasks');
    const directory=await registered.anylink_link_directory.execute('dir',{});
    assert.equal(directory.details.items!==undefined,true);
    const dirRequest=requests.at(-1);assert.equal(dirRequest.path,'/edge/v1/directory');assert.equal(dirRequest.method,'GET');assert.equal(dirRequest.token,'Bearer ak_fixture_mac');
    await registered.anylink_invoke.execute('inv',{target_device_slug:'my-phone',instruction:'告诉主人我整理完了'});
    assert.equal(requests.at(-1).path,'/edge/v1/tasks');assert.deepEqual(requests.at(-1).body.target,{device_slug:'my-phone'});assert.equal(requests.at(-1).body.instruction,'告诉主人我整理完了');
    const created=await registered.anylink_task_create.execute('make',{capability:'text.reverse',input:{text:'hi'},target_agent_id:'agent-target',ttl_seconds:600});
    const post=requests.at(-1);assert.equal(post.path,'/edge/v1/tasks');assert.equal(post.method,'POST');
    assert.deepEqual(post.body.target,{agent_id:'agent-target'});assert.equal(post.body.capability,'text.reverse');assert.equal(post.body.ttl_seconds,600);
    assert.match(post.headers['Idempotency-Key'],/^[a-f0-9]{64}$/);
    await registered.anylink_task_create.execute('make-device',{capability:'files.search',input:{q:'x'},target_device_id:'dev-1'});
    assert.deepEqual(requests.at(-1).body.target,{device_id:'dev-1'});
    await registered.anylink_task_create.execute('make-any',{capability:'files.search',input:{q:'x'}});
    assert.equal(Object.hasOwn(requests.at(-1).body,'target'),false);
    const status=await registered.anylink_task_status.execute('st',{id:'task-1'});assert.equal(requests.at(-1).path,'/edge/v1/tasks/task-1');assert.equal(status.isError,undefined);
    await registered.anylink_task_cancel.execute('cx',{id:'task-1'});assert.equal(requests.at(-1).path,'/edge/v1/tasks/task-1/cancel');assert.equal(requests.at(-1).method,'POST');
  },{onRequest:entry=>{
    if(entry.path==='/edge/v1/directory')return Response.json({items:[{device:{id:MAC,name:'Mac',slug:'home-mac',platform:'macos'},agents:[{id:'a1',key:'k',name:'n',kind:'agent',capabilities:[],last_seen_at:null,online:true,ws_online:true,self:true}]}]});
    if(entry.path==='/edge/v1/tasks'&&entry.method==='POST')return Response.json({id:'task-new',state:'queued'});
    if(entry.path.startsWith('/edge/v1/tasks/'))return Response.json({id:'task-1',state:'queued'});
    return undefined;
  }});
});

test('Protocol v3 memory assemble injects boundaries/episodes and agent_end ingests turns',async()=>{
  await fixture(async({hooks,requests})=>{
    const prompt=await hooks.before_prompt_build({currentUserMessage:'帮我看看手机上的记录'},macContext);
    assert.match(prompt.prependContext,/Learned Device Boundaries/);
    assert.match(prompt.prependContext,/Android 不支持跑编译/);
    hooks.agent_end({assistantMessage:'好的，手机上刚才记录了一段笔记。'},macContext);
    await new Promise(r=>setTimeout(r,20));
    const ingest=requests.find(r=>r.path==='/edge/v1/memory/ingest');
    assert.ok(ingest,'agent_end should asynchronously ingest completed turn');
    assert.equal(ingest.body.kind,'turn');
    assert.equal(ingest.body.messages.length,2);
  },{onRequest:entry=>{
    if(entry.path==='/edge/v1/memory/assemble')return Response.json({device_id:MAC,agent_id:'a1',memories:[GLOBAL],boundaries:[{id:'b1',title:'Android 边界',content:'Android 不支持跑编译',scope:'global',kind:'boundary',revision:1}],episodes:[],summary_text:'## Learned Device Boundaries\n- Android 不支持跑编译'});
    if(entry.path==='/edge/v1/memory/ingest')return Response.json({episode_id:'ep-1',status:'pending',debounced:true},{status:202});
    return undefined;
  }});
});

test('a transport failure on task create reports unknown outcome without a second request',async()=>{
  let posts=0;
  await fixture(async({hooks,tools})=>{
    await hooks.before_prompt_build({currentUserMessage:'派发任务'},macContext);
    const create=tools(macContext).anylink_task_create,registered=tools(macContext);
    const result=await create.execute('lost',{capability:'text.reverse',input:{}});
    assert.equal(result.details.error.code,'TASK_RESULT_UNKNOWN');assert.equal(result.isError,true);
    assert.equal(posts,1,'no automatic retry after an uncertain submission');
    const status=await registered.anylink_task_status.execute('check',{id:'maybe'});
    assert.equal(status.isError,undefined);
  },{onRequest:entry=>{if(entry.path==='/edge/v1/tasks'&&entry.method==='POST'){posts++;throw new TypeError('socket hangup');}if(entry.path.startsWith('/edge/v1/tasks/'))return Response.json({id:'maybe',state:'queued'});return undefined;}});
});

test('a known revision conflict is returned unchanged without retrying or poisoning the run',async()=>{
  let conflict=true;
  await fixture(async({hooks,requests,tools})=>{
    await hooks.before_prompt_build({currentUserMessage:'请更正记忆'},androidContext);
    const update=tools(androidContext).anylink_memory_update;
    const first=await update.execute('old-revision',{id:'fact-id',content:'新内容',expected_revision:1});
    assert.equal(first.details.error.code,'REVISION_CONFLICT');
    const count=requests.length;conflict=false;
    assert.equal((await update.execute('confirmed-revision',{id:'fact-id',content:'新内容',expected_revision:2})).details.revision,3);
    assert.equal(requests.length,count+1);
  },{onRequest:entry=>conflict&&entry.method==='PATCH'?Response.json({error:{code:'REVISION_CONFLICT'}},{status:409}):undefined});
});
