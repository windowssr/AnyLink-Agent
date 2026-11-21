import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// @ts-ignore JavaScript plugin entry, also loaded unchanged by upstream OpenClaw.
import plugin,{memoryIntent} from '../mac/plugin/index.mjs';
test('memory write intent is explicit and respects negation',()=>{assert.equal(memoryIntent('记住我喜欢中文'),true);assert.equal(memoryIntent('不要记住'),false);assert.equal(memoryIntent('你好'),false);});
test('plugin injects current cloud facts and binds writes to the current run',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'anylink-plugin-')),path=join(dir,'connection.json');await writeFile(path,JSON.stringify({server:'http://fixture',token:'ak_fixture_not_production',device_id:'mac_fixture'}));
  const hooks:any={},requests:any[]=[];let factory:any;const original=globalThis.fetch;
  globalThis.fetch=async(url:any,options:any)=>{requests.push({url,options});return Response.json(String(url).endsWith('/context')?{device_id:'mac_fixture',global:[{id:'g',content:'中文',revision:2}],device:[]}:{id:'saved',revision:1});};
  try{
    plugin.register({pluginConfig:{connectionFile:path},on:(name:string,fn:any)=>hooks[name]=fn,registerTool:(fn:any)=>factory=fn});
    const tools=factory({runId:'run1',sessionKey:'session'}),save=tools.find((x:any)=>x.name==='anylink_memory_save');
    const blocked=await save.execute('call1',{title:'x',content:'y',scope:'global'});assert.equal(blocked.details.error.code,'EXPLICIT_MEMORY_INTENT_REQUIRED');
    const prompt=await hooks.before_prompt_build({currentUserMessage:'请记住：中文',prompt:'other'},{runId:'run1'});assert.match(prompt.prependContext,/"revision":2/);
    const allowed=await save.execute('call1',{title:'x',content:'y',scope:'device'});assert.equal(allowed.details.id,'saved');assert.equal(JSON.parse(requests.at(-1).options.body).applicable_device_id,'mac_fixture');
    const other=factory({runId:'run2'}).find((x:any)=>x.name==='anylink_memory_save');assert.equal((await other.execute('call2',{})).details.error.code,'EXPLICIT_MEMORY_INTENT_REQUIRED');
    hooks.agent_end({}, {runId:'run1'});assert.equal((await save.execute('call3',{})).details.error.code,'EXPLICIT_MEMORY_INTENT_REQUIRED');
  }finally{globalThis.fetch=original;await rm(dir,{recursive:true,force:true});}
});
