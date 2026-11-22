import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {root} from './layout.mjs';
import {configuredPreview,previewAgent} from './configuration.mjs';
const file=path.join(root,'data/mac/openclaw/openclaw.json');
const preview=JSON.parse(fs.readFileSync(path.join(root,'secrets/android-preview-connection.json'),'utf8'));
const mac=JSON.parse(fs.readFileSync(path.join(root,'secrets/mac-connection.json'),'utf8'));
if(preview.device_id===mac.device_id||!preview.token?.startsWith('ak_'))throw new Error('Expected the separately authorized logical preview credential');
const original=fs.readFileSync(file),baseline=JSON.parse(original),avatarFile=path.join(root,'data/mac/branding/avatar.png');
const config=configuredPreview(baseline,root,{avatar:fs.existsSync(avatarFile),microsoftSpeech:process.argv.includes('--consent-microsoft')||baseline.tts?.provider==='microsoft'});
const destination=process.argv.includes('--apply')?file:path.join(root,'data/android-native/openclaw-proposed.json');
if(destination===file){
  const backup=path.join(root,'data/android-native/openclaw.before-native-preview.json');
  if(!fs.existsSync(backup))fs.writeFileSync(backup,original,{mode:0o600,flag:'wx'});
}
const workspace=config.agents.entries[previewAgent].workspace;
fs.mkdirSync(path.join(workspace,'avatars'),{recursive:true,mode:0o700});
if(!fs.existsSync(path.join(workspace,'SOUL.md')))fs.copyFileSync(path.join(root,'android-native/persona.md'),path.join(workspace,'SOUL.md'));
if(fs.existsSync(avatarFile))fs.copyFileSync(avatarFile,path.join(workspace,'avatars/dafeiyu.png'));
const tmp=destination+'.native-'+process.pid;
fs.writeFileSync(tmp,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
try{execFileSync(path.join(root,'data/mac/runtime/node_modules/node/bin/node'),[path.join(root,'data/mac/runtime/node_modules/openclaw/openclaw.mjs'),'config','validate','--json'],{env:{...process.env,OPENCLAW_CONFIG_PATH:tmp,OPENCLAW_STATE_DIR:path.join(root,'data/mac/openclaw'),ANYLINK_DEVICE_TOKEN:mac.token},stdio:['ignore','pipe','pipe']});fs.renameSync(tmp,destination);}catch{fs.rmSync(tmp,{force:true});throw new Error('Official OpenClaw config validation failed; existing profile was preserved');}
console.log(JSON.stringify({prepared:true,applied:destination===file,agent:previewAgent,logical_preview_only:true,gateway_loopback:true,path:path.relative(root,destination)}));
