import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {paths} from './configure.mjs';

if(process.platform!=='darwin')throw new Error('Mac computer control requires macOS.');
const lock=JSON.parse(fs.readFileSync(path.join(paths.root,'examples/mac-openclaw/control/versions.json'),'utf8'));
const cli=lock.cli[process.arch];if(!cli)throw new Error('Unsupported architecture.');
const base=path.join(paths.root,'data/mac/control');
const downloads=path.join(base,'downloads');fs.mkdirSync(downloads,{recursive:true,mode:0o700});
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for(const asset of [cli,lock.application]){
  const file=path.join(downloads,asset.name);
  if(!fs.existsSync(file)||digest(file)!==asset.sha256){
    const response=await fetch(`https://github.com/openclaw/Peekaboo/releases/download/v${lock.version}/${asset.name}`,{signal:AbortSignal.timeout(600000)});
    if(!response.ok||!response.body)throw new Error(`Official download failed (${response.status}).`);
    const temp=file+'.downloading',fd=fs.openSync(temp,'w',0o600);
    try{for await(const chunk of response.body)fs.writeSync(fd,chunk);}finally{fs.closeSync(fd);}
    if(digest(temp)!==asset.sha256)throw new Error('Official release checksum mismatch.');
    fs.renameSync(temp,file);
  }
}
const vendor=path.join(base,`vendor-${lock.version}-${process.arch}`);
if(!fs.existsSync(vendor)){
  const staging=vendor+`.installing-${process.pid}`;fs.mkdirSync(staging,{mode:0o700});
  for(const [executable,args] of [
    ['/usr/bin/tar',['-xzf',path.join(downloads,cli.name),'-C',staging]],
    ['/usr/bin/ditto',['-x','-k',path.join(downloads,lock.application.name),staging]],
  ])execFileSync(executable,args,{stdio:'inherit'});
  fs.renameSync(staging,vendor);
}
const app=path.join(vendor,'Peekaboo.app'),binary=path.join(vendor,cli.name.replace('.tar.gz',''),'peekaboo');
for(const target of [app,binary]){
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',target],{stdio:'inherit'});
  const info=spawnSync('/usr/bin/codesign',['-dv','--verbose=4',target],{encoding:'utf8'}).stderr;
  if(!lock.allowedTeams.some(team=>info.includes(`TeamIdentifier=${team}`)))throw new Error('Unexpected Peekaboo signing team.');
}
fs.writeFileSync(path.join(base,'runtime.json'),JSON.stringify({version:lock.version,app,binary},null,2)+'\n',{mode:0o600});
console.log(`Verified signed Peekaboo ${lock.version}; no macOS permissions were changed.`);
