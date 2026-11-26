import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {paths} from '../configure.mjs';

const ui=path.join(paths.runtime,'node_modules/openclaw/dist/control-ui'),art=path.join(paths.root,'data/mac/branding');
const configFile=path.join(paths.state,'openclaw.json'),config=JSON.parse(fs.readFileSync(configFile,'utf8'));
if(config.gateway?.port!==18791||config.gateway.bind!=='loopback')throw new Error('Refusing to change an unexpected Gateway profile.');
const base=config.gateway.controlUi?.basePath??'';
const packageInfo=JSON.parse(fs.readFileSync(path.join(ui,'../../package.json'),'utf8'));
if(packageInfo.version!=='2026.11.6')throw new Error('Review the branding adapter before changing the pinned OpenClaw version.');
for(const file of ['avatar.png','favicon-32.png','apple-touch-icon.png'])if(!fs.existsSync(path.join(art,file)))throw new Error('Render the local portrait first: node examples/mac-openclaw/branding/render.mjs');
const source=path.join(paths.root,'examples/mac-openclaw/branding'),folder=path.join(ui,'anylink-brand');fs.mkdirSync(folder,{recursive:true});
const original=path.join(art,'original-control-ui');fs.mkdirSync(original,{recursive:true,mode:0o700});
for(const file of ['index.html','favicon.svg','favicon.ico','favicon-32.png','apple-touch-icon.png','manifest.webmanifest'])if(fs.existsSync(path.join(ui,file))&&!fs.existsSync(path.join(original,file)))fs.copyFileSync(path.join(ui,file),path.join(original,file));
for(const file of ['avatar.png','favicon-32.png','apple-touch-icon.png'])fs.copyFileSync(path.join(art,file),path.join(folder,file));
for(const file of ['brand.js','brand.css'])fs.copyFileSync(path.join(source,file),path.join(folder,file));
const avatar=fs.readFileSync(path.join(art,'avatar.png'));
const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><image width="512" height="512" href="data:image/png;base64,${avatar.toString('base64')}"/></svg>`;
fs.writeFileSync(path.join(folder,'favicon.svg'),svg);fs.writeFileSync(path.join(ui,'favicon.svg'),svg);
for(const file of ['favicon-32.png','apple-touch-icon.png'])fs.copyFileSync(path.join(art,file),path.join(ui,file));
// A PNG-backed Windows icon; no additional image library or model download.
const small=fs.readFileSync(path.join(art,'favicon-32.png')),ico=Buffer.alloc(22);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico[6]=ico[7]=32;ico.writeUInt16LE(1,10);ico.writeUInt16LE(32,12);ico.writeUInt32LE(small.length,14);ico.writeUInt32LE(22,18);fs.writeFileSync(path.join(ui,'favicon.ico'),Buffer.concat([ico,small]));
const version=crypto.createHash('sha256').update(avatar).update(fs.readFileSync(path.join(source,'brand.js'))).update(fs.readFileSync(path.join(source,'brand.css'))).digest('hex').slice(0,12);
const htmlFile=path.join(ui,'index.html');let html=fs.readFileSync(htmlFile,'utf8').replace(/\n?<!-- anylink-brand:start -->[\s\S]*?<!-- anylink-brand:end -->\n?/g,'\n');
if(!html.includes('</head>')||!html.includes('openclaw-favicon-svg'))throw new Error('Pinned Control UI entry contract changed; refusing to patch.');
html=html.replace('<title>OpenClaw Control</title>','<title>大肥鱼 · AnyLink</title>').replace('</head>',`<!-- anylink-brand:start -->\n<link rel="stylesheet" href="${base}/anylink-brand/brand.css?v=${version}">\n<script type="module" src="${base}/anylink-brand/brand.js?v=${version}"></script>\n<!-- anylink-brand:end -->\n</head>`);
fs.writeFileSync(htmlFile,html);
const manifest=JSON.parse(fs.readFileSync(path.join(ui,'manifest.webmanifest'),'utf8'));manifest.name='大肥鱼 · AnyLink';manifest.short_name='大肥鱼';fs.writeFileSync(path.join(ui,'manifest.webmanifest'),JSON.stringify(manifest));
for(const agent of ['main','companion']){
 const entry=config.agents?.entries?.[agent];if(!entry)continue;
 const workspace=entry.workspace??(agent==='main'?paths.workspace:path.join(paths.root,'data/mac/companion/workspace'));
 fs.mkdirSync(path.join(workspace,'avatars'),{recursive:true,mode:0o700});fs.writeFileSync(path.join(workspace,'avatars/dafeiyu.png'),avatar,{mode:0o600});
 entry.identity={...entry.identity,name:entry.identity?.name??config.agents.entries.main?.identity?.name??'大肥鱼',avatar:'avatars/dafeiyu.png'};
}
const next=JSON.stringify(config,null,2)+'\n';if(fs.readFileSync(configFile,'utf8')!==next){const backup=path.join(art,'openclaw.before-branding.json');if(!fs.existsSync(backup))fs.writeFileSync(backup,fs.readFileSync(configFile),{mode:0o600});const temporary=configFile+'.branding';fs.writeFileSync(temporary,next,{mode:0o600});fs.renameSync(temporary,configFile);}
fs.writeFileSync(path.join(art,'manifest.json'),JSON.stringify({version,upstream:'2026.11.6',source:'local Live2D model render',applied_at:new Date().toISOString()},null,2)+'\n',{mode:0o600});
console.log('Applied DaFeiYu page branding, favicons and both local agent portraits. No model or tool settings changed.');
