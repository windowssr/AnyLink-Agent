import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const paths={root,state:path.join(root,'data/mac/openclaw'),workspace:path.join(root,'data/mac/workspace'),connection:path.join(root,'secrets/mac-connection.json'),gateway:path.join(root,'secrets/mac-gateway-token'),runtime:path.join(root,'data/mac/runtime'),plugin:path.join(root,'examples/mac-openclaw/plugin')};
export function configure(connection){
  if(os.platform()!=='darwin')throw new Error('This profile requires native macOS');
  for(const dir of [path.join(root,'secrets'),paths.state,paths.workspace,path.join(root,'data/mac/logs')])fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const save=(file,value)=>{fs.writeFileSync(file,value,{mode:0o600});fs.chmodSync(file,0o600);};
  save(paths.connection,JSON.stringify(connection,null,2)+'\n');
  const token=fs.existsSync(paths.gateway)?fs.readFileSync(paths.gateway,'utf8').trim():crypto.randomBytes(32).toString('base64url');save(paths.gateway,token+'\n');
  const config={
    gateway:{mode:'local',bind:'loopback',port:18791,auth:{mode:'token',token},controlUi:{enabled:true,basePath:'/openclaw',allowedOrigins:['http://127.0.0.1:18791','http://localhost:18791']},http:{endpoints:{chatCompletions:{enabled:true}}}},
    agents:{defaults:{workspace:paths.workspace,model:{primary:'anylink/deepseek-flash'},thinkingDefault:'off',maxConcurrent:1,timeoutSeconds:180,compaction:{memoryFlush:{enabled:false}}}},
    cron:{enabled:false},discovery:{mdns:{mode:'off'}},
    models:{mode:'replace',providers:{anylink:{baseUrl:connection.server+'/model/v1',apiKey:'${ANYLINK_DEVICE_TOKEN}',api:'openai-completions',models:[{id:'deepseek-flash',name:'DeepSeek Flash via AnyLink',reasoning:false,input:['text','image'],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}},
    tools:{profile:'coding',fs:{workspaceOnly:true},exec:{security:'allowlist',ask:'on-miss'},deny:['sessions_spawn','sessions_send','cron','gateway','message']},
    plugins:{allow:['anylink-memory','anylink-mac-control'],load:{paths:[paths.plugin,path.join(root,'examples/mac-openclaw/control')]},slots:{memory:'none'},entries:{'anylink-memory':{enabled:true,hooks:{allowConversationAccess:true,allowPromptInjection:true},config:{connectionFile:paths.connection}},'anylink-mac-control':{enabled:true,hooks:{allowConversationAccess:true,allowPromptInjection:true},config:{projectRoot:root}}}},
  };
  save(path.join(paths.state,'openclaw.json'),JSON.stringify(config,null,2)+'\n');
  console.log(JSON.stringify({configured:true,device_id:connection.device_id,workspace:paths.workspace,chat_url:'http://127.0.0.1:18791/openclaw/',cloud_agent:false}));
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const input=fs.readFileSync(0,'utf8');configure(JSON.parse(input));
}
