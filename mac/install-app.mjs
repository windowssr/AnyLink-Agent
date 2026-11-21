import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

if(process.platform!=='darwin')throw new Error('Install AnyLink.app on macOS.');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.join(root,'artifacts/desktop/AnyLink.app');
const target=path.join(os.homedir(),'Applications/AnyLink.app');
if(!fs.existsSync(source))throw new Error('Build first: node mac/build-app.mjs');
const id=app=>execFileSync('/usr/bin/defaults',['read',path.join(app,'Contents/Info'),'CFBundleIdentifier'],{encoding:'utf8'}).trim();
if(id(source)!=='com.anylink.desktop')throw new Error('Unexpected build bundle identifier.');
if(fs.existsSync(target)&&id(target)!=='com.anylink.desktop')throw new Error('An unrelated AnyLink.app exists; refusing to replace it.');
// Refuse to replace an open executable. Quit the UI first; the background Agent stays running.
const running=execFileSync('/bin/ps',['-axo','comm='],{encoding:'utf8'}).split('\n').some(line=>line.trim()===path.join(target,'Contents/MacOS/AnyLink'));
if(running)throw new Error('Quit the AnyLink window application before updating it. The background Agent can keep running.');
const stamp=new Date().toISOString().replaceAll(/[:.]/g,'-');
const staging=path.join(path.dirname(target),`.AnyLink.installing-${process.pid}.app`);
fs.mkdirSync(path.dirname(target),{recursive:true});
if(fs.existsSync(staging))throw new Error('A previous .installing folder exists. Inspect it before retrying.');
execFileSync('/usr/bin/ditto',[source,staging]);
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',staging],{stdio:'inherit'});
if(fs.existsSync(target)){
  const previous=path.join(path.dirname(target),`.AnyLink.previous-${stamp}.app`);
  fs.renameSync(target,previous);
  try{fs.renameSync(staging,target);}catch(error){fs.renameSync(previous,target);throw error;}
}else fs.renameSync(staging,target);
console.log(`Installed ${target}. Open it with: open ~/Applications/AnyLink.app`);
