import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {paths} from './configure.mjs';
const connection=JSON.parse(fs.readFileSync(paths.connection,'utf8'));
const node=path.join(paths.runtime,'node_modules/node/bin/node');
const cli=path.join(paths.runtime,'node_modules/openclaw/openclaw.mjs');
const log=event=>process.stdout.write(JSON.stringify({event,time:new Date().toISOString()})+'\n');
let stopping=false,gateway;
const tunnel=spawn('/usr/bin/ssh',['-N','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=30','-o','ServerAliveCountMax=3','-L','127.0.0.1:3181:127.0.0.1:3180',connection.ssh_host??'ywc'],{stdio:['ignore','ignore','inherit']});
const shutdown=()=>{if(stopping)return;stopping=true;gateway?.kill('SIGTERM');tunnel.kill('SIGTERM');};
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
tunnel.on('error',()=>{log('ssh_start_failed');shutdown();process.exitCode=1;});
tunnel.on('exit',()=>{if(!stopping){log('ssh_disconnected');shutdown();process.exitCode=1;}});
let ready=false;
for(let i=0;i<40&&!stopping;i++){
  try{const r=await fetch(connection.server+'/edge/v1/identity',{headers:{Authorization:`Bearer ${connection.token}`},signal:AbortSignal.timeout(2000)});if(r.status===401)throw new Error('DEVICE_AUTH_REVOKED');if(r.ok){const data=await r.json();if(data.device.id!==connection.device_id)throw new Error('DEVICE_BINDING_MISMATCH');ready=true;break;}}catch(e){if(e.message==='DEVICE_AUTH_REVOKED'||e.message==='DEVICE_BINDING_MISMATCH'){log(e.message);shutdown();break;}}
  await delay(500);
}
if(!ready){log('cloud_services_unavailable');shutdown();process.exitCode=1;}
else{
  log('cloud_memory_and_model_connected');
  const env={...process.env,PATH:path.dirname(node)+':'+(process.env.PATH??'/usr/bin:/bin'),OPENCLAW_STATE_DIR:paths.state,OPENCLAW_CONFIG_PATH:path.join(paths.state,'openclaw.json'),OPENCLAW_NO_RESPAWN:'1',NODE_COMPILE_CACHE:path.join(paths.state,'compile-cache'),ANYLINK_DEVICE_TOKEN:connection.token};
  // DeepSeek credentials never enter this process. Native OpenClaw owns the loop.
  delete env.DEEPSEEK_API_KEY;
  gateway=spawn(node,[cli,'gateway','--port','18791','--bind','loopback'],{env,stdio:'inherit',cwd:paths.workspace});
  gateway.on('error',()=>{log('local_openclaw_start_failed');shutdown();process.exitCode=1;});
  await new Promise(resolve=>gateway.on('exit',(code)=>{if(!stopping)process.exitCode=code??1;shutdown();resolve();}));
}
