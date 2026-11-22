import fs from 'node:fs';import path from 'node:path';import {execFileSync,spawn} from 'node:child_process';
const known=[];
function collect(v){if(!v||typeof v!=='object')return;for(const [k,x] of Object.entries(v)){if(typeof x==='string'&&/^(token|api_?key|password|ownerToken|gatewayToken|deepseekApiKey)$/i.test(k)&&x.length>=20&&!/^(test-|REPLACE_|CONFIGURE_)/.test(x))known.push(Buffer.from(x));else if(typeof x==='object')collect(x);}}
if(fs.existsSync('secrets'))for(const name of fs.readdirSync('secrets')){
 const p=path.join('secrets',name);if(!fs.statSync(p).isFile())continue;
 if(name.endsWith('.json')){try{collect(JSON.parse(fs.readFileSync(p,'utf8')));}catch{}}
 if(['owner-token','mac-gateway-token'].includes(name)){const value=fs.readFileSync(p,'utf8').trim();if(value.length>=20)known.push(Buffer.from(value));}
}
const pattern=/\bsk-[A-Za-z0-9]{24,}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bak_[A-Za-z0-9_-]{30,}\b|\bap_[A-Za-z0-9_-]{30,}\b/;
const findings=[];
function inspect(bytes,location){if(known.some(v=>bytes.includes(v))||pattern.test(bytes.toString('utf8')))findings.push(location);}
const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
for(const file of files){if(fs.existsSync(file)&&fs.statSync(file).isFile())inspect(fs.readFileSync(file),{kind:'worktree',path:file});}
const objects=execFileSync('git',['rev-list','--objects','--all'],{encoding:'utf8',maxBuffer:16*1024*1024}).trim().split('\n');
const names=new Map(objects.map(line=>[line.slice(0,40),line.slice(41)]));
const child=spawn('git',['cat-file','--batch'],{stdio:['pipe','pipe','inherit']});const completion=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});child.stdin.end([...names.keys()].join('\n')+'\n');
let buffer=Buffer.alloc(0),header,blobs=0;
for await(const chunk of child.stdout){
 buffer=Buffer.concat([buffer,chunk]);
 while(true){
  if(!header){const end=buffer.indexOf(10);if(end<0)break;const [sha,type,size]=buffer.subarray(0,end).toString().split(' ');header={sha,type,size:Number(size)};if(!Number.isSafeInteger(header.size))throw new Error('Invalid Git object stream');buffer=buffer.subarray(end+1);}
  if(buffer.length<header.size+1)break;
  if(header.type==='blob'){blobs++;const name=names.get(header.sha);inspect(buffer.subarray(0,header.size),{kind:'history',object:header.sha,path:name});if(/^(secrets|data|backups)\//.test(name))findings.push({kind:'private-path',object:header.sha,path:name});}
  buffer=buffer.subarray(header.size+1);header=undefined;
 }
}
const status=await completion;if(status!==0||header||buffer.length)throw new Error('Incomplete Git history audit');
const report={passed:findings.length===0,current_files:files.length,historical_blobs:blobs,findings};fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/public-source-audit.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));if(findings.length)process.exitCode=1;
