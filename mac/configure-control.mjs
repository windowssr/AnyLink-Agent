import fs from 'node:fs';
import path from 'node:path';
import {paths} from './configure.mjs';

const file=path.join(paths.state,'openclaw.json');
const config=JSON.parse(fs.readFileSync(file,'utf8'));
if(config.gateway?.port!==18791||config.gateway?.bind!=='loopback')throw new Error('Unexpected Mac profile.');
const backup=file+'.before-control-'+new Date().toISOString().replaceAll(/[:.]/g,'-');
fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600);
const model=config.models?.providers?.anylink?.models?.find(m=>m.id==='deepseek-flash');
if(!model)throw new Error('Expected AnyLink model was not found.');
model.input=['text','image'];
config.agents.defaults.timeoutSeconds=Math.max(config.agents.defaults.timeoutSeconds??120,180);
config.plugins.allow=[...new Set([...config.plugins.allow,'anylink-mac-control'])];
config.plugins.load.paths=[...new Set([...config.plugins.load.paths,path.join(paths.root,'mac/control')])];
config.plugins.entries['anylink-mac-control']={enabled:true,hooks:{allowConversationAccess:true,allowPromptInjection:true},config:{projectRoot:paths.root}};
const temp=file+`.control-${process.pid}`;
fs.writeFileSync(temp,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temp,file);
console.log('Configured Mac control tools and image input; existing credentials and approval policy retained.');
