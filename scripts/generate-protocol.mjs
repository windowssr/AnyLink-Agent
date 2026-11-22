import fs from 'node:fs';
import {z} from 'zod';
import {capabilitiesSchema,taskCreateSchema,taskResultSchema,taskSchema} from '../server/link.ts';
import {connectSchema} from '../server/edge-auth.ts';
const installIdSchema=z.object({install_id:z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/)}).strict();
import {memorySchema,memoryPatchSchema,memorySearchSchema,deviceSchema} from '../server/store.ts';
import {modelInputSchema} from '../server/model-proxy.ts';
import {speechSchema} from '../server/speech.ts';
const schemas={Connect:connectSchema,InstallId:installIdSchema,Capabilities:capabilitiesSchema,TaskInput:taskCreateSchema,TaskResult:taskResultSchema,Task:taskSchema,MemoryInput:memorySchema,MemoryPatch:memoryPatchSchema,MemorySearch:memorySearchSchema,ChatCompletions:modelInputSchema,Speech:speechSchema,Device:deviceSchema};
const paths={};
function route(url,method,{schema,owner=false,key=false,summary,response,join=false}={}){
  const params=[];
  if(url.includes('{id}'))params.push({name:'id',in:'path',required:true,schema:{type:'string',format:'uuid'}});
  if(key)params.push({name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',minLength:1,maxLength:160}});
  if(method==='delete')params.push({name:'If-Match',in:'header',required:true,schema:{type:'string',description:'Current memory revision'}});
  paths[url]??={};paths[url][method]={summary,security:[{[join?'joinKey':owner?'ownerSession':'deviceBearer']:[]}],parameters:params,...(schema?{requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/'+schema}}}}}:{}),responses:{'200':{description:'Successful operation',...(response?{content:{'application/json':{schema:{$ref:'#/components/schemas/'+response}}}}:{})},'201':{description:'Created; one-time secret when issuing credentials'},'400':{description:'Invalid input'},'401':{description:'Invalid or revoked credential'},'403':{description:'Not permitted for this identity'},'404':{description:'Not visible to this agent'},'409':{description:'Revision, idempotency, routing or terminal-state conflict'},...(join?{'503':{description:'Join disabled'}}:{})}};
}
route('/edge/v1/connect','post',{schema:'Connect',join:true,summary:'Join with the owner key: upsert install device and agent, rotate its credential (201)'});
route('/edge/v1/device/install-id','post',{schema:'InstallId',summary:'Adopt an install_id for the credential device so join connect keeps its identity and memories'});
for(const name of ['protocol','directory','peers','capabilities','tasks','tasks/{id}','tasks/claim','tasks/{id}/result','tasks/{id}/cancel']){
 const prefix='/edge/v1/link/';
 if(name==='protocol')route(prefix+name,'get',{summary:'Negotiate AnyLink protocol 2.0 and delivery semantics'});
 if(name==='directory')route(prefix+name,'get',{summary:'List live agents per device with capabilities, presence and self marker'});
 if(name==='peers')route(prefix+name,'get',{summary:'Deprecated device-level compatibility view; use directory for agent routing'});
 if(name==='capabilities')route(prefix+name,'post',{schema:'Capabilities',key:true,summary:'Replace this agent capability manifest'});
 if(name==='tasks'){route(prefix+name,'get',{summary:'List this agent tasks (role=source|target, optional state; newest 100)'});route(prefix+name,'post',{schema:'TaskInput',key:true,summary:'Create a task routed to an agent, a device, or any capable agent',response:'Task'});}
 if(name==='tasks/{id}')route(prefix+name,'get',{summary:'Read a task visible to source, target or claiming agent',response:'Task'});
 if(name==='tasks/claim')route(prefix+name,'post',{key:true,summary:'Atomically claim one routed task, or return {task:null}; never auto-requeue'});
 if(name==='tasks/{id}/result')route(prefix+name,'post',{schema:'TaskResult',key:true,summary:'Persist an executor result; only the claiming agent',response:'Task'});
 if(name==='tasks/{id}/cancel')route(prefix+name,'post',{key:true,summary:'Cancel queued work or request cooperative cancellation; only the source agent',response:'Task'});
}
for(const name of ['identity','context','persona'])route('/edge/v1/'+name,'get',{summary:'Read authenticated '+(name==='persona'?'persona document':'agent '+name)});
route('/edge/v1/memories','post',{schema:'MemoryInput',key:true,summary:'Save an explicit owner fact; agent scope binds the caller agent'});
route('/edge/v1/memories/{id}','patch',{schema:'MemoryPatch',key:true,summary:'Revise memory with expected_revision'});
route('/edge/v1/memories/{id}','delete',{key:true,summary:'Tombstone a memory using If-Match'});
route('/edge/v1/memories/search','post',{schema:'MemorySearch',summary:'Read-only search: q, scope and optional device_id'});
route('/model/v1/chat/completions','post',{schema:'ChatCompletions',summary:'OpenAI Chat Completions compatible passthrough; JSON or SSE; never automatically replay'});
route('/model/v1/speech','post',{schema:'Speech',summary:'Spoken reply audio: sanitize + optional summarize + Microsoft neural TTS; mp3 base64'});
paths['/edge/v1/link/tasks'].get.parameters.push({name:'role',in:'query',schema:{type:'string',enum:['source','target'],default:'source'}},{name:'state',in:'query',schema:{type:'string',enum:['queued','running','cancel_requested','succeeded','failed','cancelled','unknown','expired']}});
route('/v1/devices','get',{owner:true,summary:'List owner devices with their agents'});
route('/v1/devices','post',{schema:'Device',owner:true,key:true,summary:'Register a logical device'});
route('/v1/agents','get',{owner:true,summary:'List all agents across devices'});
route('/v1/agents/{id}/revoke','post',{owner:true,summary:'Revoke an agent and its credentials; queued targeted tasks stop routing'});
route('/v1/agents/{id}/restore','post',{owner:true,summary:'Restore a revoked agent; it must reconnect for a new credential'});
route('/v1/devices/{id}/restore','post',{owner:true,summary:'Restore a revoked device and its agents; credentials stay revoked and agents must reconnect'});
route('/v1/devices/{id}/credential','post',{owner:true,summary:'Issue a one-time credential bound to the device default agent (201); not replayable'});
paths['/v1/devices/{id}/credential'].post.responses['201']={description:'One-time secret: device_id, agent_id, credential_id and token. Store privately.'};
delete paths['/v1/devices/{id}/credential'].post.responses['200'];
paths['/v1/auth/login']={post:{summary:'Log in as the single deployment owner',security:[],requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['token'],additionalProperties:false,properties:{token:{type:'string',minLength:1,maxLength:200}}}}}},responses:{'200':{description:'Authenticated; Set-Cookie supplies anylink_session'},'401':{description:'Invalid owner token'}}}};
const document={openapi:'3.1.0',info:{title:'AnyLink Protocol',version:'2.0.0',description:'Preview, single-owner reference service. One join key connects devices and agents; the cloud relays shared memory, model passthrough and routed tasks. Hosts own execution, approvals and local policy. It does not run an agent.'},servers:[{url:'http://127.0.0.1:3180',description:'Local service or secure tunnel; remote deployments require HTTPS'}],paths,components:{securitySchemes:{deviceBearer:{type:'http',scheme:'bearer',description:'Revocable agent credential issued by connect or the owner console'},joinKey:{type:'http',scheme:'bearer',description:'Owner join key from server secrets; any holder may connect an install and dispatch to any agent'},ownerSession:{type:'apiKey',in:'cookie',name:'anylink_session',description:'Session from POST /v1/auth/login; inspect devices, agents and status through /v1'}},schemas:Object.fromEntries(Object.entries(schemas).map(([name,schema])=>{const {$schema:_,...value}=z.toJSONSchema(schema);return[name,value];}))}};
const output=JSON.stringify(document,null,2)+'\n',file='protocol/openapi.json';
if(process.argv.includes('--check')){if(fs.readFileSync(file,'utf8')!==output)throw new Error('Run npm run protocol:generate and commit the updated contract');}
else fs.writeFileSync(file,output);
console.log(process.argv.includes('--check')?'Protocol matches the server schemas':'Generated protocol/openapi.json');
