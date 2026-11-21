import fs from 'node:fs';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {paths} from './configure.mjs';
const connection=JSON.parse(fs.readFileSync(paths.connection,'utf8'));
const node=path.join(paths.runtime,'node_modules/node/bin/node'),cli=path.join(paths.runtime,'node_modules/openclaw/openclaw.mjs');
const args=process.argv.slice(2);
if(args[0]==='token'){process.stdout.write(fs.readFileSync(paths.gateway,'utf8'));}
else if(args[0]==='open'){
  const token=fs.readFileSync(paths.gateway,'utf8').trim();execFileSync('/usr/bin/open',['http://127.0.0.1:18791/#token='+encodeURIComponent(token)]);console.log('Opened the local Mac OpenClaw dashboard.');
}else{
  const env={...process.env,OPENCLAW_STATE_DIR:paths.state,OPENCLAW_CONFIG_PATH:path.join(paths.state,'openclaw.json'),OPENCLAW_NO_RESPAWN:'1',ANYLINK_DEVICE_TOKEN:connection.token,NODE_COMPILE_CACHE:path.join(paths.state,'compile-cache')};delete env.DEEPSEEK_API_KEY;
  const r=spawnSync(node,[cli,...args],{env,stdio:'inherit',cwd:paths.workspace});process.exit(r.status??1);
}
