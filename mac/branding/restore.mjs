import fs from 'node:fs';
import path from 'node:path';
import {paths} from '../configure.mjs';
const art=path.join(paths.root,'data/mac/branding'),ui=path.join(paths.runtime,'node_modules/openclaw/dist/control-ui');
const version=JSON.parse(fs.readFileSync(path.join(ui,'../../package.json'),'utf8')).version;
if(version!=='2026.11.6')throw new Error('Do not restore an old UI entry onto another runtime version.');
const original=path.join(art,'original-control-ui');
const names=['index.html','favicon.svg','favicon.ico','favicon-32.png','apple-touch-icon.png','manifest.webmanifest'];
for(const name of names)if(!fs.existsSync(path.join(original,name)))throw new Error('Original UI backup is incomplete.');
const configFile=path.join(paths.state,'openclaw.json'),config=JSON.parse(fs.readFileSync(configFile,'utf8')),before=JSON.parse(fs.readFileSync(path.join(art,'openclaw.before-branding.json'),'utf8'));
for(const id of ['main','companion']){
 const current=config.agents?.entries?.[id]?.identity,previous=before.agents?.entries?.[id]?.identity;
 if(current?.avatar!=='avatars/dafeiyu.png')continue;
 if(previous?.avatar!==undefined)current.avatar=previous.avatar;else delete current.avatar;
}
const temporary=configFile+'.branding';fs.writeFileSync(temporary,JSON.stringify(config,null,2)+'\n',{mode:0o600});fs.renameSync(temporary,configFile);
for(const name of names)fs.copyFileSync(path.join(original,name),path.join(ui,name));
fs.rmSync(path.join(ui,'anylink-brand'),{recursive:true,force:true});fs.writeFileSync(path.join(art,'disabled'),'disabled\n',{mode:0o600});
console.log('Restored original Control UI and previous avatar fields. Restart the idle Gateway and reload the page.');
