import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import plugin from './index.mjs';
import {projectRoot} from './client.mjs';

const profile=JSON.parse(fs.readFileSync(path.join(projectRoot,'data/mac/openclaw/openclaw.json'),'utf8'));
const run='mac-control-'+randomBytes(6).toString('hex'),file=run+'.txt',full=path.join(profile.agents.defaults.workspace,file);
const content=`AnyLink Mac GUI proof ${run}\n鼠标和键盘已连接。\n`;
let factory;plugin.register({pluginConfig:{projectRoot},on(){},registerTool(fn){factory=fn;}});
const tools=factory({runId:run,sessionKey:run}),steps=[];
async function call(name,input){
  const result=await tools.find(t=>t.name===name).execute(run+'-'+steps.length,input,AbortSignal.timeout(60000));
  steps.push({name,input,details:result.details});
  console.log(JSON.stringify({tool:name,state:result.details.state,success:result.details.success,ready:result.details.ready,error:result.details.error}));
  return result;
}
let passed=false;
try{
  assert.equal((await call('anylink_mac_status',{})).details.ready,true,'Enable Mac control and grant Peekaboo permissions first.');
  fs.writeFileSync(full,'AnyLink GUI proof pending\n',{flag:'wx',mode:0o600});
  const app='com.apple.TextEdit';
  const launch=await call('anylink_mac_act',{action:'launch',app,workspace_file:file});assert.equal(launch.details.success,true);
  const window=launch.details.windows?.windows?.find(w=>w.window_title?.includes(run));assert.ok(window,'The proof document did not open.');
  let view=await call('anylink_mac_observe',{app,window_id:window.window_id});assert.ok(view.details.observation_id);
  const focused=await call('anylink_mac_act',{action:'focus',app,observation_id:view.details.observation_id});assert.equal(focused.details.success,true);
  view={details:focused.details.next_observation};assert.ok(view.details?.observation_id);
  const editor=view.details.elements.find(e=>e.ax_role==='AXTextArea');assert.ok(editor,'The proof editor was not found.');
  const click=await call('anylink_mac_act',{action:'click',app,observation_id:view.details.observation_id,x:editor.bounds.x+30,y:editor.bounds.y+24,foreground:true});assert.equal(click.details.success,true);
  assert.ok(click.details.next_observation?.observation_id,'Observe again if input succeeded but its follow-up observation failed.');
  const typed=await call('anylink_mac_act',{action:'type',app,observation_id:click.details.next_observation.observation_id,text:content,clear:true,foreground:true});assert.equal(typed.details.success,true);
  assert.ok(typed.details.next_observation?.observation_id);
  const saved=await call('anylink_mac_act',{action:'key',app,observation_id:typed.details.next_observation.observation_id,key:'cmd+s',foreground:true});assert.equal(saved.details.success,true);
  for(let i=0;i<30;i++){if(fs.readFileSync(full,'utf8')===content)break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(fs.readFileSync(full,'utf8'),content);passed=true;
}finally{
  fs.writeFileSync(path.join(projectRoot,'artifacts',run+'.json'),JSON.stringify({run,file,passed,content,steps,checkedAt:new Date().toISOString()},null,2)+'\n');
  console.log(JSON.stringify({run,file,passed}));
}
