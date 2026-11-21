import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {paths} from './configure.mjs';
const connection=JSON.parse(fs.readFileSync(paths.connection,'utf8'));
const node=path.join(paths.runtime,'node_modules/node/bin/node'),cli=path.join(paths.runtime,'node_modules/openclaw/openclaw.mjs');
const log=event=>process.stdout.write(JSON.stringify({event,time:new Date().toISOString()})+'\n');
// Reapply only the reviewed cosmetic adapter after a pinned runtime reinstall.
// A missing portrait or incompatible UI never prevents the Agent from starting.
if(fs.existsSync(path.join(paths.root,'data/mac/branding/avatar.png'))&&!fs.existsSync(path.join(paths.root,'data/mac/branding/disabled'))){
  try{execFileSync(node,[path.join(paths.root,'mac/branding/apply.mjs')],{stdio:['ignore','inherit','inherit']});}
  catch{log('ui_branding_not_applied');}
}
let stopping=false,tunnel,reconnect;
function connect(){
  if(stopping)return;
  tunnel=spawn('/usr/bin/ssh',['-N','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-L','127.0.0.1:3181:127.0.0.1:3180',connection.ssh_host??'ywc'],{stdio:['ignore','ignore','inherit']});
  let scheduled=false;
  const retry=()=>{if(stopping||scheduled)return;scheduled=true;log('cloud_tunnel_reconnecting');reconnect=setTimeout(connect,3000);};
  tunnel.on('error',retry);tunnel.on('exit',retry);
}
connect();
const env={...process.env,PATH:path.dirname(node)+':'+(process.env.PATH??'/usr/bin:/bin'),OPENCLAW_STATE_DIR:paths.state,OPENCLAW_CONFIG_PATH:path.join(paths.state,'openclaw.json'),OPENCLAW_NO_RESPAWN:'1',NODE_COMPILE_CACHE:path.join(paths.state,'compile-cache'),ANYLINK_DEVICE_TOKEN:connection.token};
// The native local Gateway stays alive while the cloud tunnel reconnects.
// DeepSeek credentials never enter this process; OpenClaw owns the Agent loop.
delete env.DEEPSEEK_API_KEY;
const gateway=spawn(node,[cli,'gateway','--port','18791','--bind','loopback'],{env,stdio:'inherit',cwd:paths.workspace});
// Keep the model connection available until the native Gateway has drained its owned work.
const shutdown=()=>{if(stopping)return;stopping=true;clearTimeout(reconnect);gateway.kill('SIGTERM');};
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
gateway.on('error',()=>{log('local_openclaw_start_failed');shutdown();process.exitCode=1;});
await new Promise(resolve=>gateway.on('close',code=>{if(!stopping)process.exitCode=code??1;stopping=true;clearTimeout(reconnect);tunnel?.kill('SIGTERM');resolve();}));
