import fs from 'node:fs';
import {z} from 'zod';
import {capabilitiesSchema,taskCreateSchema,taskResultSchema,taskSchema,grantSchema} from '../server/link.ts';
import {memorySchema,memoryPatchSchema,memorySearchSchema,deviceSchema} from '../server/store.ts';
import {modelInputSchema} from '../server/model-proxy.ts';
const schemas={Capabilities:capabilitiesSchema,TaskInput:taskCreateSchema,TaskResult:taskResultSchema,Task:taskSchema,Grant:grantSchema,MemoryInput:memorySchema,MemoryPatch:memoryPatchSchema,MemorySearch:memorySearchSchema,ChatCompletions:modelInputSchema,Device:deviceSchema};
const paths={};
function route(url,method,{schema,owner=false,key=false,summary,response}={}){
  const params=[];
  if(url.includes('{id}'))params.push({name:'id',in:'path',required:true,schema:{type:'string',format:'uuid'}});
  if(key)params.push({name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',minLength:1,maxLength:160}});
  if(method==='delete')params.push({name:'If-Match',in:'header',required:true,schema:{type:'string',description:'Current memory revision'}});
  paths[url]??={};paths[url][method]={summary,security:[{[owner?'ownerSession':'deviceBearer']:[]}],parameters:params,...(schema?{requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/'+schema}}}}}:{}),responses:{'200':{description:'Successful operation',...(response?{content:{'application/json':{schema:{$ref:'#/components/schemas/'+response}}}}:{})},'400':{description:'Invalid input'},'401':{description:'Invalid or revoked credential'},'403':{description:'Capability not granted'},'404':{description:'Not visible to this device'},'409':{description:'Revision, idempotency or terminal-state conflict'}}};
}
for(const name of ['protocol','peers','capabilities','tasks','tasks/{id}','tasks/claim','tasks/{id}/result','tasks/{id}/cancel']){
 const prefix='/edge/v1/link/';
 if(name==='protocol')route(prefix+name,'get',{summary:'Negotiate AnyLink protocol and delivery semantics'});
 if(name==='peers')route(prefix+name,'get',{summary:'Discover only owner-granted targets and capabilities; last_seen_at is not worker presence'});
 if(name==='capabilities')route(prefix+name,'post',{schema:'Capabilities',key:true,summary:'Replace this device capability manifest'});
 if(name==='tasks'){route(prefix+name,'get',{summary:'List this device tasks (role=source|target, optional state; newest 100)'});route(prefix+name,'post',{schema:'TaskInput',key:true,summary:'Create a task under an explicit owner grant',response:'Task'});}
 if(name==='tasks/{id}')route(prefix+name,'get',{summary:'Read a source or target task',response:'Task'});
 if(name==='tasks/claim')route(prefix+name,'post',{key:true,summary:'Atomically claim one task, or return {task:null}; never auto-requeue'});
 if(name==='tasks/{id}/result')route(prefix+name,'post',{schema:'TaskResult',key:true,summary:'Persist an executor result',response:'Task'});
 if(name==='tasks/{id}/cancel')route(prefix+name,'post',{key:true,summary:'Cancel queued work or request cooperative cancellation',response:'Task'});
}
route('/v1/link/grants','post',{schema:'Grant',owner:true,key:true,summary:'Create, update or revoke an owner-managed capability grant'});
route('/v1/link/grants','get',{owner:true,summary:'List owner-managed grants'});
for(const name of ['identity','context'])route('/edge/v1/'+name,'get',{summary:'Read authenticated device '+name});
route('/edge/v1/memories','post',{schema:'MemoryInput',key:true,summary:'Save an explicit owner fact'});
route('/edge/v1/memories/{id}','patch',{schema:'MemoryPatch',key:true,summary:'Revise memory with expected_revision'});
route('/edge/v1/memories/{id}','delete',{key:true,summary:'Tombstone a memory using If-Match'});
route('/edge/v1/memories/search','post',{schema:'MemorySearch',summary:'Read-only search: q, scope and optional device_id'});
route('/model/v1/chat/completions','post',{schema:'ChatCompletions',summary:'OpenAI Chat Completions compatible passthrough; JSON or SSE; never automatically replay'});
paths['/edge/v1/link/tasks'].get.parameters.push({name:'role',in:'query',schema:{type:'string',enum:['source','target'],default:'source'}},{name:'state',in:'query',schema:{type:'string',enum:['queued','running','cancel_requested','succeeded','failed','cancelled','unknown','expired']}});
route('/v1/devices','post',{schema:'Device',owner:true,key:true,summary:'Register a logical device'});
route('/v1/devices/{id}/credential','post',{owner:true,summary:'Issue a one-time device credential (201); not replayable'});
paths['/v1/devices/{id}/credential'].post.responses['201']={description:'One-time secret: device_id, credential_id and token. Store privately.'};
delete paths['/v1/devices/{id}/credential'].post.responses['200'];
paths['/v1/auth/login']={post:{summary:'Log in as the single deployment owner',security:[],requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['token'],additionalProperties:false,properties:{token:{type:'string',minLength:1,maxLength:200}}}}}},responses:{'200':{description:'Authenticated; Set-Cookie supplies anylink_session'},'401':{description:'Invalid owner token'}}}};
const document={openapi:'3.1.0',info:{title:'AnyLink Protocol',version:'1.0.0',description:'Preview, single-owner reference service. Hosts own execution, approvals and per-operation authorization. Cloud relays data; it does not run an agent.'},servers:[{url:'http://127.0.0.1:3180',description:'Local service or secure tunnel; remote deployments require HTTPS'}],paths,components:{securitySchemes:{deviceBearer:{type:'http',scheme:'bearer',description:'Revocable device service credential, not an LLM provider key'},ownerSession:{type:'apiKey',in:'cookie',name:'anylink_session',description:'Session from POST /v1/auth/login; provision devices and credentials through /v1/devices'}},schemas:Object.fromEntries(Object.entries(schemas).map(([name,schema])=>{const {$schema:_,...value}=z.toJSONSchema(schema);return[name,value];}))}};
const output=JSON.stringify(document,null,2)+'\n',file='protocol/openapi.json';
if(process.argv.includes('--check')){if(fs.readFileSync(file,'utf8')!==output)throw new Error('Run npm run protocol:generate and commit the updated contract');}
else fs.writeFileSync(file,output);
console.log(process.argv.includes('--check')?'Protocol matches the server schemas':'Generated protocol/openapi.json');
