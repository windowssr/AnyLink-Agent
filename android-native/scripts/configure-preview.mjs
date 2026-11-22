import fs from 'node:fs';
import path from 'node:path';
import {root} from './layout.mjs';
import {configuredPreview,previewAgent} from './configuration.mjs';
const file=path.join(root,'data/mac/openclaw/openclaw.json');
const preview=JSON.parse(fs.readFileSync(path.join(root,'secrets/android-preview-connection.json'),'utf8'));
const mac=JSON.parse(fs.readFileSync(path.join(root,'secrets/mac-connection.json'),'utf8'));
if(preview.device_id===mac.device_id||!preview.token?.startsWith('ak_'))throw new Error('Expected the separately authorized logical preview credential');
const original=fs.readFileSync(file),config=configuredPreview(JSON.parse(original),root);
const destination=process.argv.includes('--apply')?file:path.join(root,'data/android-native/openclaw-proposed.json');
if(destination===file){
  const backup=path.join(root,'data/android-native/openclaw.before-native-preview.json');
  if(!fs.existsSync(backup))fs.writeFileSync(backup,original,{mode:0o600,flag:'wx'});
}
const workspace=config.agents.entries[previewAgent].workspace;
fs.mkdirSync(path.join(workspace,'avatars'),{recursive:true,mode:0o700});
fs.copyFileSync(path.join(root,'android-native/persona.md'),path.join(workspace,'SOUL.md'));
fs.copyFileSync(path.join(root,'data/mac/branding/avatar.png'),path.join(workspace,'avatars/dafeiyu.png'));
const tmp=destination+'.native-'+process.pid;
fs.writeFileSync(tmp,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(tmp,destination);
console.log(JSON.stringify({prepared:true,applied:destination===file,agent:previewAgent,logical_preview_only:true,gateway_loopback:true,path:path.relative(root,destination)}));
