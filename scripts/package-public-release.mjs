import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
const root=process.cwd(),pkgVersion=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,tag=`v${pkgVersion}`,out=path.join(root,'artifacts/public/releases',tag);
const run=(cmd,args,options={})=>execFileSync(cmd,args,{cwd:root,encoding:'utf8',...options});
if(run('git',['status','--porcelain']).trim())throw new Error('Commit intended source before packaging');
const revision=run('git',['rev-parse','HEAD']).trim();
run(process.execPath,['scripts/audit-public.mjs'],{stdio:'inherit'});
run(process.execPath,['examples/android-native/scripts/inspect-apk.mjs'],{stdio:'inherit'});
const apk=JSON.parse(fs.readFileSync('artifacts/android-native/apk-inspection.json'));
const app=path.join(root,'artifacts/public/desktop/AnyLink.app');
if(JSON.parse(fs.readFileSync(path.join(app,'Contents/Resources/desktop.json'))).projectRoot!=='')throw new Error('Public Mac package must not contain a personal project root');
if(run('/usr/bin/plutil',['-extract','AnyLinkSourceRevision','raw','-o','-',path.join(app,'Contents/Info.plist')]).trim()!==revision.slice(0,12))throw new Error('Rebuild the Mac App at the committed source');
run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
const secrets=[];
for(const name of ['mac-connection.json','android-preview-connection.json']){const p=path.join(root,'secrets',name);if(fs.existsSync(p))secrets.push(Buffer.from(JSON.parse(fs.readFileSync(p)).token));}
for(const name of ['owner-token','mac-gateway-token']){const p=path.join(root,'secrets',name);if(fs.existsSync(p))secrets.push(Buffer.from(fs.readFileSync(p,'utf8').trim()));}
const visited=new Set();let inspected=0;
function scan(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){
 const file=path.join(dir,item.name),real=fs.realpathSync(file);
 if(!real.startsWith(app+path.sep))throw new Error('Mac archive contains an external symlink');
 if(visited.has(real))continue;visited.add(real);
 if(fs.statSync(real).isDirectory()){scan(real);continue;}
 if(item.name.endsWith('.moc3')||/live2dcubismcore/i.test(item.name))throw new Error('Restricted asset in public Mac bundle');
 const data=fs.readFileSync(real);inspected++;
 if(secrets.some(s=>s.length&&data.includes(s))||/\bsk-[A-Za-z0-9]{24,}\b|\bak_[A-Za-z0-9_-]{30,}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b/.test(data.toString())||data.includes(Buffer.from(os.homedir())))throw new Error('Private credential or personal path in public Mac bundle: '+path.relative(app,file));
}}
scan(app);fs.mkdirSync(out,{recursive:true});
const apkName=`AnyLink-Android-${apk.version}.apk`,macName=`AnyLink-macOS-arm64-${pkgVersion}.zip`;
if(apkName.includes('private')||apk.version.includes('private'))throw new Error('Private character APK can never enter the public release');
const apkBuildInfo=JSON.parse(execFileSync('/usr/bin/unzip',['-p',path.join(root,'artifacts/android-native',apkName),'assets/anylink/build-info.json'],{encoding:'utf8'}));
if(apkBuildInfo.private_character!==false)throw new Error('Public release APK must be the asset-free character build');
fs.copyFileSync(path.join(root,'artifacts/android-native',apkName),path.join(out,apkName));
run('/usr/bin/ditto',['-c','-k','--keepParent','--norsrc',app,path.join(out,macName)]);
const sdkPackages=JSON.parse(run('npm',['pack','./sdk','--pack-destination',out,'--cache',path.join(root,'data/public-release/npm-cache'),'--json']));
const mcpPackages=JSON.parse(run('npm',['pack','./mcp','--pack-destination',out,'--cache',path.join(root,'data/public-release/npm-cache'),'--json']));
const sdkName=sdkPackages[0].filename,mcpName=mcpPackages[0].filename;
const names=[apkName,macName,sdkName,mcpName];
const assets=names.map(name=>{const data=fs.readFileSync(path.join(out,name));return {name,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};});
const manifest={release:tag,source:revision,license:'MIT (original code; third-party exclusions apply)',versions:{service:pkgVersion,sdk:pkgVersion,mcp:pkgVersion,mac:pkgVersion,android:apk.version,protocol:'3.2'},assets,public_character_assets:false,mac_signature:'ad-hoc; not notarized',android_signature:'debug',hardware_verified:false,mac_files_inspected:inspected};
fs.writeFileSync(path.join(out,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const checksums=[...assets,{name:'release-manifest.json',sha256:createHash('sha256').update(fs.readFileSync(path.join(out,'release-manifest.json'))).digest('hex')}].map(a=>`${a.sha256}  ${a.name}`).join('\n')+'\n';
fs.writeFileSync(path.join(out,'SHA256SUMS'),checksums);console.log(JSON.stringify({release:tag,source:revision,folder:out,assets:assets.map(a=>({name:a.name,bytes:a.bytes}))}));
