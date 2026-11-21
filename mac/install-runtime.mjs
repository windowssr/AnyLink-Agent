import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {paths} from './configure.mjs';
if(os.platform()!=='darwin')throw new Error('The Mac harness must run natively on macOS');
const npm=fs.realpathSync(execFileSync('/usr/bin/which',['npm'],{encoding:'utf8'}).trim());
const bootstrap=path.join(paths.root,'data/mac/bootstrap-node');
const bootstrapNode=path.join(bootstrap,'node_modules/node/bin/node');
if(!fs.existsSync(bootstrapNode)){
  const r=spawnSync(process.execPath,[npm,'install','--prefix',bootstrap,'--save-exact','node@24.22.3','--no-audit','--no-fund'],{stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);
}
fs.mkdirSync(paths.runtime,{recursive:true});
const locked=path.join(paths.root,'mac/runtime-lock.json');
if(!fs.existsSync(locked))throw new Error('The checked-in Mac runtime lock is required');
fs.copyFileSync(locked,path.join(paths.runtime,'package-lock.json'));
fs.writeFileSync(path.join(paths.runtime,'package.json'),JSON.stringify({name:'anylink-mac-runtime',private:true,version:'0.2.0',dependencies:{node:'24.22.3',openclaw:'2026.11.6'}},null,2)+'\n');
const r=spawnSync(bootstrapNode,[npm,'ci','--prefix',paths.runtime,'--omit=dev','--no-audit','--no-fund'],{stdio:'inherit',env:{...process.env,PATH:path.dirname(bootstrapNode)+':'+process.env.PATH}});process.exit(r.status??1);
