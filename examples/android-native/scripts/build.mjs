import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {root,home,source,sdk,output,environment,lock,tools} from './layout.mjs';
const live=process.argv.includes('--live'),testing=process.argv.includes('--test')||live;
const prepare=!process.argv.includes('--no-prepare');
if(prepare)execFileSync(process.execPath,[path.join(home,'scripts/prepare.mjs')],{stdio:'inherit'});
fs.mkdirSync(output,{recursive:true});
const env=environment(),agent=process.env.ANYLINK_AGENT_ID??'anylink-android-preview';
if(testing){
  const testHome=path.join(root,'data/android-native/test-user'),maven=path.join(root,'data/android-native/maven-cache');
  fs.mkdirSync(testHome,{recursive:true});fs.mkdirSync(maven,{recursive:true});
  env.JAVA_TOOL_OPTIONS+=` -Duser.home="${testHome}" -Dmaven.repo.local="${maven}"`;
  execFileSync(process.execPath,[path.join(home,'scripts/prefetch-test-sdk.mjs')],{env,stdio:'inherit'});
}
if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agent))throw new Error('Invalid configured Android agent ID');
if(!process.argv.includes('--dependencies')&&!fs.existsSync(path.join(sdk,'platforms/android-37.0/android.jar')))throw new Error('Install the authorized SDK first: node examples/android-native/scripts/install-toolchain.mjs --accept-sdk-license');
const app=path.join(source,'apps/android'),version=JSON.parse(fs.readFileSync(path.join(home,'package.json'),'utf8')).version;
const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const privateCharacter=process.env.ANYLINK_CHARACTER_MODE==='private';
if(JSON.parse(fs.readFileSync(path.join(source,'apps/android/app/src/main/assets/anylink/character-mode.json'))).private_character!==privateCharacter)throw new Error('Prepared character mode differs from requested distribution; prepare again');
fs.writeFileSync(path.join(source,'apps/android/app/src/main/assets/anylink/build-info.json'),JSON.stringify({product:'AnyLink',version,upstream:lock.commit,source:revision,source_dirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim().length>0,agent_context:agent,private_character:privateCharacter,architecture:'device-agent',gateway_required:false},null,2)+'\n');
const versionCode=3014;
const args=['gradlew','--no-daemon','--max-workers=2','--console=plain','-Dorg.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8 --enable-native-access=ALL-UNNAMED','-Pkotlin.compiler.execution.strategy=in-process','-POPENCLAW_ANDROID_VERSION_NAME='+version,'-POPENCLAW_ANDROID_VERSION_CODE='+versionCode,'-PANYLINK_AGENT_ID='+agent];
if(process.argv.includes('--dependencies'))args.push('help');
else if(live)args.push(':app:testThirdPartyDebugUnitTest','--tests','ai.openclaw.app.anylink.AnyLinkLiveTest');
else if(testing)args.push(':app:testThirdPartyDebugUnitTest','--tests','ai.openclaw.app.anylink.AnyLinkAgentTest','--tests','ai.openclaw.app.anylink.AnyLinkCloudUiTest','--tests','ai.openclaw.app.anylink.AnyLinkPhoneTest');
else args.push(':app:assembleThirdPartyDebug');
const logPath=path.join(output,live?'live.log':testing?'test.log':'build.log'),log=fs.openSync(logPath,'w');
console.log('Building pinned official Android source with AnyLink UI; log: '+path.relative(root,logPath));
await new Promise((resolve,reject)=>{
  const installation=path.join(root,'data/android-native/gradle-distribution/gradle-'+tools.gradle.version);
  let verified=false;try{verified=JSON.parse(fs.readFileSync(path.join(installation,'anylink-verified.json'))).sha256===tools.gradle.sha256;}catch{}
  const child=verified?spawn(path.join(installation,'bin/gradle'),args.slice(1),{cwd:app,env,stdio:['ignore',log,log]}):spawn('/bin/sh',args,{cwd:app,env,stdio:['ignore',log,log]});
  child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('Android Gradle task failed; inspect '+path.relative(root,logPath))));
});fs.closeSync(log);
if(!testing&&!process.argv.includes('--dependencies')){
  const dir=path.join(app,'app/build/outputs/apk/thirdParty/debug');
  const metadata=JSON.parse(fs.readFileSync(path.join(dir,'output-metadata.json'),'utf8'));
  if(metadata.elements.length!==1||metadata.elements[0].versionName!==version+'-debug'||metadata.elements[0].versionCode!==versionCode)throw new Error('APK output metadata does not match the selected debug version');
  const name=metadata.elements[0].outputFile;
  if(!name)throw new Error('No built APK was produced');
  const target=path.join(output,'AnyLink-Android-'+version+(privateCharacter?'-private':'')+'.apk');fs.copyFileSync(path.join(dir,name),target);
  console.log('Built '+target+' (development debug signature; independent on-device Agent).');
}
