import fs from 'node:fs';
import path from 'node:path';
import {paths} from './configure.mjs';

const file=path.join(paths.state,'openclaw.json');
if(!fs.existsSync(file))throw new Error('Pair this Mac first: node mac/pair.mjs');
const config=JSON.parse(fs.readFileSync(file,'utf8'));
if(config.gateway?.port!==18791||config.gateway?.bind!=='loopback')throw new Error('Unexpected Gateway profile; refusing to change it.');
if(config.gateway.controlUi?.basePath==='/openclaw'){
  console.log('Desktop UI path is already configured.');
}else{
  const stamp=new Date().toISOString().replaceAll(/[:.]/g,'-');
  const backup=path.join(paths.state,`openclaw.pre-desktop-${stamp}.json`);
  fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600);
  config.gateway.controlUi={...config.gateway.controlUi,basePath:'/openclaw'};
  const temporary=file+`.desktop-${process.pid}`;
  fs.writeFileSync(temporary,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
  fs.renameSync(temporary,file);
  console.log('Configured /openclaw for the local UI; existing credentials and tool settings retained. The Gateway may reload.');
}
