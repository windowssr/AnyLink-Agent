import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..'),lock=JSON.parse(fs.readFileSync(path.join(root,'examples/mac-openclaw/companion/runtime-lock.json'),'utf8'));
const home=path.join(root,'data/mac/companion'),model=path.join(home,'model'),runtime=path.join(home,'runtime');
if(!fs.existsSync(path.join(home,'installed.json'))&&!process.argv.includes('--accept-third-party-licenses'))throw new Error('Read examples/mac-openclaw/companion/ASSET-NOTICE.md and the linked author/Core terms, then explicitly pass --accept-third-party-licenses for private local use. Public redistribution is not granted.');
for(const directory of [home,model,runtime])fs.mkdirSync(directory,{recursive:true,mode:0o700});
const hash=(data,algorithm='sha256')=>createHash(algorithm).update(data).digest('hex');
const blob=data=>hash(Buffer.concat([Buffer.from(`blob ${data.length}\0`),data]),'sha1');
async function download(url,file,valid){
  if(fs.existsSync(file)&&valid(fs.readFileSync(file)))return;
  const response=await fetch(url,{signal:AbortSignal.timeout(900000)});
  if(!response.ok)throw new Error('Asset HTTP '+response.status+': '+path.basename(file));
  const data=Buffer.from(await response.arrayBuffer());if(!valid(data))throw new Error('Asset integrity mismatch: '+path.basename(file));
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file+'.downloading',data,{mode:0o600});fs.renameSync(file+'.downloading',file);
}
const pending=[...lock.model.files];
await Promise.all(Array.from({length:3},async()=>{
  while(pending.length){const asset=pending.shift(),url=`https://raw.githubusercontent.com/${lock.model.repository}/${lock.model.commit}/`+asset.path.split('/').map(encodeURIComponent).join('/');
    await download(url,path.join(model,asset.path),data=>data.length===asset.bytes&&blob(data)===asset.blob);
    console.log('Verified model asset: '+asset.path);
  }
}));
const core=lock.core;
await download(`https://raw.githubusercontent.com/${core.repository}/${core.commit}/`+core.path.split('/').map(encodeURIComponent).join('/'),path.join(runtime,'live2dcubismcore.min.js'),data=>hash(data)===core.sha256);
// The author's original entry and all files stay intact. This local adapter
// only declares the actually supplied safe expressions and hand motions.
const entry=JSON.parse(fs.readFileSync(path.join(model,'大肥鱼.model3.json'),'utf8'));
fs.copyFileSync(path.join(root,'examples/mac-openclaw/companion/idle.motion3.json'),path.join(model,'anylink-idle.motion3.json'));
fs.chmodSync(path.join(model,'anylink-idle.motion3.json'),0o600);
entry.FileReferences.Motions={
  Idle:[{File:'anylink-idle.motion3.json',FadeInTime:0.4,FadeOutTime:0.4}],
  Wave:[{File:'Animation/默认手切举手.motion3.json',FadeInTime:0.25,FadeOutTime:0.25}],
  WaveReturn:[{File:'Animation/举手切默认手.motion3.json',FadeInTime:0.25,FadeOutTime:0.25}],
  Point:[{File:'Animation/竖手指切出来动画.motion3.json',FadeInTime:0.25,FadeOutTime:0.25}],
  PointReturn:[{File:'Animation/竖手指切回默认.motion3.json',FadeInTime:0.25,FadeOutTime:0.25}],
};
entry.FileReferences.Expressions=[{Name:'blush',File:'Exp3/脸红.exp3.json'},{Name:'concerned',File:'Exp3/流冷汗.exp3.json'},{Name:'smile',File:'Exp3/＞＜.exp3.json'}];
fs.writeFileSync(path.join(model,'entry.model3.json'),JSON.stringify(entry,null,2)+'\n',{mode:0o600});
fs.writeFileSync(path.join(home,'installed.json'),JSON.stringify({model:lock.model.repository,commit:lock.model.commit,core_sha256:core.sha256,local_only:true,redistribute_model:false},null,2)+'\n',{mode:0o600});
console.log('Prepared private Live2D model and Core. No microphone, camera, model inference or cloud changes.');
