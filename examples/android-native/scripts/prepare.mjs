import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {root, home, source, lock, node, tools} from './layout.mjs';
const run=(args,options={})=>execFileSync('git',args,{cwd:source,encoding:'utf8',...options});
const privateCharacter=process.env.ANYLINK_CHARACTER_MODE==='private';
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if(!fs.existsSync(path.join(source,'.git'))){
  fs.mkdirSync(path.dirname(source),{recursive:true});
  execFileSync('git',['clone','--filter=blob:none','--sparse','--depth','1','--branch',lock.tag,lock.repository,source],{stdio:'inherit'});
}
if(run(['rev-parse','HEAD']).trim()!==lock.commit||run(['remote','get-url','origin']).trim()!==lock.repository)throw new Error('The official source checkout does not match the pinned upstream.');
run(['sparse-checkout','set',...lock.sparseDirectories],{stdio:'inherit'});
const priorFile=path.join(root,'data/android-native/prepared-files.json');
const prior=fs.existsSync(priorFile)?JSON.parse(fs.readFileSync(priorFile,'utf8')):{},prepared={};
function publish(relative,bytes){
  const target=path.join(source,relative);
  if(fs.existsSync(target)){
    let baseline;try{baseline=run(['show','HEAD:'+relative],{stdio:['ignore','pipe','ignore']});}catch{}
    const current=fs.readFileSync(target);
    if(!current.equals(bytes)&&!(baseline!==undefined&&current.equals(Buffer.from(baseline)))&&prior[relative]!==hash(target))throw new Error('Preserving unrelated edits in '+relative);
  }
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);prepared[relative]=hash(target);
}
function patch(relative,from,to){
  const baseline=run(['show','HEAD:'+relative]);
  if(baseline.split(from).length!==2)throw new Error('Pinned source context changed for '+relative);
  publish(relative,Buffer.from(baseline.replace(from,to)));
}
patch('apps/android/app/build.gradle.kts','applicationId = openClawAndroidApplicationId','applicationId = "com.anylink.agent"');
// Merge this second edit with the first expected output, preserving the same base.
const gradle='apps/android/app/build.gradle.kts';
let build=fs.readFileSync(path.join(source,gradle),'utf8');
if(build.split('compileSdk = 37').length!==2)throw new Error('Pinned compile SDK context changed');
build=build.replace('compileSdk = 37','compileSdk = 37\n  buildToolsVersion = "37.0.0"');
build=build.replace('buildConfigField("String", "BUILD_TIMESTAMP", "\\\"$openClawBuildTimestamp\\\"")',
  'buildConfigField("String", "BUILD_TIMESTAMP", "\\\"$openClawBuildTimestamp\\\"")\n    val anyLinkAgent = providers.gradleProperty("ANYLINK_AGENT_ID").orElse("anylink-android-preview").get()\n    require(anyLinkAgent.matches(Regex("[a-z0-9][a-z0-9_-]{0,63}")))\n    buildConfigField("String", "ANYLINK_AGENT_ID", "\\\"$anyLinkAgent\\\"")');
if(!build.includes('"ANYLINK_AGENT_ID"'))throw new Error('Cannot add the configured Android context.');
const mermaidCommand='commandLine("pnpm", "--dir", "packages/mermaid-renderer", "build")';
if(build.split(mermaidCommand).length!==2)throw new Error('Pinned Mermaid build context changed');
build=build.replace(mermaidCommand,`commandLine(${JSON.stringify(node)}, ${JSON.stringify(path.join(home,'scripts/build-mermaid.mjs'))})\n    inputs.file(${JSON.stringify(path.join(home,'renderer/package-lock.json'))})\n    inputs.file(${JSON.stringify(path.join(home,'scripts/build-mermaid.mjs'))})`);
// The reference keeps the pinned Android build machinery, not the retired
// Gateway companion runtime. Explicit source sets prevent dormant node/voice
// entry points and their unrelated tests from entering the product artifact.
build += `
android.sourceSets.configureEach {
  java.directories.clear()
  kotlin.directories.clear()
}
android.sourceSets.getByName("main").kotlin.directories.add("src/anylink/java")
android.sourceSets.getByName("test").kotlin.directories.add("src/anylinkTest/java")
`;
fs.writeFileSync(path.join(source,gradle),build);prepared[gradle]=hash(path.join(source,gradle));
// Shared/benchmark/watch modules are configured by the official root build too;
// keep their SDK tool choice consistent instead of admitting another auto-install.
for(const module of ['wear-shared','wear','benchmark'])patch(`apps/android/${module}/build.gradle.kts`,'compileSdk = 37','compileSdk = 37\n  buildToolsVersion = "37.0.0"');
const settingsPath='apps/android/settings.gradle.kts';
const settings=run(['show','HEAD:'+settingsPath]);
if(settings.split('mavenCentral()').length!==3)throw new Error('Pinned Maven repository context changed');
publish(settingsPath,Buffer.from(settings.replaceAll('mavenCentral()',`maven { url = uri(${JSON.stringify(tools.mavenCentralUrl)}) }`)));
patch('apps/android/gradle/wrapper/gradle-wrapper.properties','networkTimeout=10000','networkTimeout=60000');
publish('apps/android/gradle/gradle-daemon-jvm.properties',Buffer.from('toolchainVersion=17\n'));
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(item=>item.isDirectory()?walk(path.join(dir,item.name)):[path.join(dir,item.name)]);}
for(const file of walk(path.join(home,'overlay'))){
  const relative=path.relative(path.join(home,'overlay'),file).replace('app/src/main/java/','app/src/anylink/java/').replace('app/src/test/java/','app/src/anylinkTest/java/');
  publish('apps/android/'+relative,fs.readFileSync(file));
}
for(const relative of ['ai/openclaw/app/ui/SystemAnimations.kt','ai/openclaw/app/AndroidLicenseNotices.kt']) {
  publish('apps/android/app/src/anylink/java/'+relative,Buffer.from(run(['show','HEAD:apps/android/app/src/main/java/'+relative])));
}

// Complete cutover: remove or restore files produced by the retired Gateway UI adapter.
for(const [relative,expected] of Object.entries(prior)) {
  if(prepared[relative])continue;
  const target=path.join(source,relative);
  if(!fs.existsSync(target))continue;
  if(hash(target)!==expected)throw new Error('Preserving unrelated edits in retired adapter '+relative);
  let baseline;try{baseline=run(['show','HEAD:'+relative],{stdio:['ignore','pipe','ignore']});}catch{}
  if(baseline!==undefined)fs.writeFileSync(target,baseline);else fs.unlinkSync(target);
}
const assets=path.join(source,'apps/android/app/src/main/assets/anylink');fs.mkdirSync(assets,{recursive:true});
fs.copyFileSync(path.join(root,'LICENSE'),path.join(assets,'AnyLink-LICENSE.txt'));
fs.copyFileSync(path.join(root,'examples/persona/dafeiyu.md'),path.join(assets,'persona-shared.md'));
fs.copyFileSync(path.join(home,'persona.md'),path.join(assets,'persona-android.md'));
fs.copyFileSync(path.join(home,'licenses/OpenClaw-MIT.txt'),path.join(assets,'OpenClaw-MIT.txt'));
for(const name of ['model','live2dcubismcore.min.js','pixi.min.js','cubism4-colors.min.js','public-avatar.js'])fs.rmSync(path.join(assets,name),{recursive:true,force:true});
const drawable=path.join(source,'apps/android/app/src/main/res/drawable');fs.mkdirSync(drawable,{recursive:true});
for(const ext of ['png','xml'])fs.rmSync(path.join(drawable,'anylink_avatar.'+ext),{force:true});
if(privateCharacter){
  for(const name of ['portrait.html','avatar.js'])fs.copyFileSync(path.join(home,'web',name),path.join(assets,name));
  const model=path.join(root,'data/mac/companion/model');
  if(!fs.existsSync(path.join(model,'entry.model3.json')))throw new Error('Prepare privately licensed character assets first.');
  fs.cpSync(model,path.join(assets,'model'),{recursive:true});
  // Phone GPUs and WebView texture memory are tighter than the Mac's: shrink the
  // copied 4096px textures to 1024 for this build only so mobile WebGL never OOMs. Source assets stay untouched.
  const modelOut=path.join(assets,'model');
  for(const dir of fs.readdirSync(modelOut,{withFileTypes:true,recursive:true})){
    if(!dir.isFile()||!dir.name.endsWith('.png'))continue;
    const file=path.join(dir.parentPath??dir.path??modelOut,dir.name);
    try{const size=execFileSync('sips',['-g','pixelWidth','-g','pixelHeight',file],{encoding:'utf8'});
      if(/pixelWidth:\s*(\d+)/.exec(size)&&Number(/pixelWidth:\s*(\d+)/.exec(size)[1])>1024)
        execFileSync('sips',['-Z','1024',file],{stdio:'pipe'});}catch{/* keep original texture */}
  }
  for(const [from,name] of [['data/mac/companion/runtime/live2dcubismcore.min.js','live2dcubismcore.min.js'],['examples/mac-openclaw/companion/vendor/pixi.min.js','pixi.min.js'],['examples/mac-openclaw/companion/vendor/cubism4-colors.min.js','cubism4-colors.min.js']])fs.copyFileSync(path.join(root,from),path.join(assets,name));
  fs.copyFileSync(path.join(root,'data/mac/branding/avatar.png'),path.join(drawable,'anylink_avatar.png'));
}else{
  fs.copyFileSync(path.join(home,'web/public-portrait.html'),path.join(assets,'portrait.html'));
  fs.copyFileSync(path.join(home,'web/public-avatar.js'),path.join(assets,'public-avatar.js'));
  fs.rmSync(path.join(assets,'avatar.js'),{force:true});
  fs.writeFileSync(path.join(drawable,'anylink_avatar.xml'),'<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="256dp" android:height="256dp" android:viewportWidth="256" android:viewportHeight="256"><path android:fillColor="#468CAF" android:pathData="M128,16A112,112 0,1 0,128 240A112,112 0,1 0,128 16"/><path android:strokeColor="#D9F8FF" android:strokeWidth="14" android:strokeLineCap="round" android:pathData="M65,180L128,62L191,180M92,132L164,132"/></vector>');
}
fs.writeFileSync(path.join(assets,'character-mode.json'),JSON.stringify({private_character:privateCharacter})+'\n');
const debug=path.join(source,'apps/android/app/src/debug/res');
patch('apps/android/app/src/debug/res/values/strings.xml','OpenClaw Dev','大肥鱼 · AnyLink');
const brandXml='<?xml version="1.0" encoding="utf-8"?><resources><string name="app_name">大肥鱼 · AnyLink</string></resources>\n';
// The upstream debug source set already declares the default app_name. Replace
// that declaration; declaring it in another debug XML produces duplicate resources.
const oldDefaultBrand=path.join(debug,'values/anylink_brand.xml');
if(fs.existsSync(oldDefaultBrand)){
  if(fs.readFileSync(oldDefaultBrand,'utf8')!==brandXml)throw new Error('Preserving unrelated default brand resources');
  fs.unlinkSync(oldDefaultBrand);
}
for(const name of fs.readdirSync(path.join(source,'apps/android/app/src/main/res')).filter(n=>/^values(?:-|$)/.test(n))){
  if(name==='values')continue;
  publish(`apps/android/app/src/debug/res/${name}/anylink_brand.xml`,Buffer.from(brandXml));
}
for(const name of ['ic_launcher.xml','ic_launcher_round.xml']){
  const folder=path.join(debug,'mipmap-anydpi-v26');fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,name),'<?xml version="1.0" encoding="utf-8"?><adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@android:color/white"/><foreground android:drawable="@drawable/anylink_avatar"/></adaptive-icon>\n');
}
const licenses=path.join(source,'apps/android/THIRD_PARTY_LICENSES/openclaw/licenses');
for(const name of ['pixi-js-LICENSE.txt','pixi-live2d-display-LICENSE.txt','AIRI-LICENSE.txt'])fs.copyFileSync(path.join(root,'examples/mac-openclaw/companion/vendor',name),path.join(licenses,'AnyLink-'+name));
fs.copyFileSync(path.join(root,'examples/mac-openclaw/companion/ASSET-NOTICE.md'),path.join(licenses,'AnyLink-character-notice.txt'));
// Reuse the same pinned OpenClaw installation's build-only dependencies. This
// does not install the monorepo, modify it, or bundle Node into the Android app.
const dependencies=path.join(root,'data/mac/runtime/node_modules');
for(const [name,version] of [['esbuild','0.28.2'],['typebox','1.4.2']]){
  if(JSON.parse(fs.readFileSync(path.join(dependencies,name,'package.json'),'utf8')).version!==version)throw new Error('The pinned '+name+' build dependency is unavailable.');
}
const link=path.join(source,'node_modules');if(!fs.existsSync(link))fs.symlinkSync(dependencies,link,'dir');
fs.writeFileSync(priorFile,JSON.stringify(prepared,null,2)+'\n',{mode:0o600});
execFileSync(node,[path.join(source,'scripts/prepare-native-protocol.mjs'),'--language','kotlin'],{cwd:source,stdio:'inherit'});
execFileSync(node,[path.join(source,'scripts/android-app-i18n.ts'),'generate'],{cwd:source,stdio:'inherit'});
console.log('Prepared independent AnyLink Android Agent on the pinned native UI build. No Gateway or model credentials copied.');
