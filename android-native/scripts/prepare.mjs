import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {root, home, source, lock, node} from './layout.mjs';
const run=(args,options={})=>execFileSync('git',args,{cwd:source,encoding:'utf8',...options});
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
build=build.replace('buildConfigField("String", "BUILD_TIMESTAMP", "\\\"$openClawBuildTimestamp\\\"")',
  'buildConfigField("String", "BUILD_TIMESTAMP", "\\\"$openClawBuildTimestamp\\\"")\n    val anyLinkAgent = providers.gradleProperty("ANYLINK_AGENT_ID").orElse("anylink-android-preview").get()\n    require(anyLinkAgent.matches(Regex("[a-z0-9][a-z0-9_-]{0,63}")))\n    buildConfigField("String", "ANYLINK_AGENT_ID", "\\\"$anyLinkAgent\\\"")');
if(!build.includes('"ANYLINK_AGENT_ID"'))throw new Error('Cannot add the configured Android context.');
fs.writeFileSync(path.join(source,gradle),build);prepared[gradle]=hash(path.join(source,gradle));
patch('apps/android/app/src/main/java/ai/openclaw/app/ui/ShellScreen.kt','{ ShellNavigation() }','{ ShellNavigation(activeTab = Tab.Chat) }');
patch('apps/android/gradle/wrapper/gradle-wrapper.properties','networkTimeout=10000','networkTimeout=60000');
// AGP 9.5 and Gradle 9.7 officially support JDK17. Reuse the installed JDK,
// rather than downloading the upstream contributor preference for JDK21.
publish('apps/android/gradle/gradle-daemon-jvm.properties',Buffer.from('toolchainVersion=17\n'));
const runtimePath='apps/android/app/src/main/java/ai/openclaw/app/NodeRuntime.kt';
let runtime=run(['show','HEAD:'+runtimePath]);
for(const [from,to] of [
  ['selectedChatAgentId\n            ?: defaultAgentId.takeIf',
    'selectedChatAgentId\n            ?: BuildConfig.ANYLINK_AGENT_ID.takeIf { id -> selectable.any { it.id == id } }\n            ?: defaultAgentId.takeIf'],
  ['  fun setTalkModeEnabled(value: Boolean): Unit = setVoiceCaptureMode(if (value) VoiceCaptureMode.TalkMode else VoiceCaptureMode.Off)',
    `  fun setTalkModeEnabled(value: Boolean): Unit = setVoiceCaptureMode(if (value) VoiceCaptureMode.TalkMode else VoiceCaptureMode.Off)

  /** A granted microphone request must bind both visible Chat and Talk under the live Gateway owner. */
  internal fun startAnyLinkTalk(): Boolean =
    synchronized(gatewayDataScopeLock) {
      val agentId = BuildConfig.ANYLINK_AGENT_ID
      if (
        !operatorConnected || !_isForeground.value || gatewayConnectionHandoff.value.pending ||
        !hasRecordAudioPermission() || gatewayAgents.value.selectableAgents().none { it.id == agentId }
      ) return@synchronized false
      // Talk owns the node-main conversation. Do not restore an older selected chat
      // asynchronously after presenting that conversation to the user.
      setTalkModeEnabled(false)
      retirePendingChatSelection()
      selectedChatAgentId = agentId
      prepareMainSessionKey(agentId, MainSessionUpdate.Select)
      setTalkModeEnabled(true)
      true
    }`],
]){if(runtime.split(from).length!==2)throw new Error('Pinned runtime context changed');runtime=runtime.replace(from,to);}
publish(runtimePath,Buffer.from(runtime));
const viewModelPath='apps/android/app/src/main/java/ai/openclaw/app/MainViewModel.kt';
let viewModel=run(['show','HEAD:'+viewModelPath]);
for(const [from,to] of [
  ['import ai.openclaw.app.i18n.NativeText','import ai.openclaw.app.i18n.NativeText\nimport ai.openclaw.app.i18n.nativeText'],
  ['  fun setTalkModeEnabled(enabled: Boolean): Unit = ensureRuntime().setTalkModeEnabled(enabled)',
    `  fun setTalkModeEnabled(enabled: Boolean): Unit = ensureRuntime().setTalkModeEnabled(enabled)

  internal fun startAnyLinkTalk() {
    if (!ensureRuntime().startAnyLinkTalk()) {
      showTalkSetupMessage(nativeText("Connect to a Gateway with the configured Android agent and allow Microphone access before starting Talk."))
    }
  }`],
]){if(viewModel.split(from).length!==2)throw new Error('Pinned ViewModel context changed');viewModel=viewModel.replace(from,to);}
publish(viewModelPath,Buffer.from(viewModel));
const talkPath='apps/android/app/src/main/java/ai/openclaw/app/ui/chat/ChatRealtimeTalk.kt';
let talk=run(['show','HEAD:'+talkPath]);
for(const [from,to] of [
  ['requiresSetup: Boolean,\n): ChatRealtimeTalkLaunch','requiresSetup: Boolean,\n  nativeSpeech: Boolean = false,\n): ChatRealtimeTalkLaunch'],
  ['requiresSetup -> ChatRealtimeTalkLaunch.ShowSetupMessage','requiresSetup && !nativeSpeech -> ChatRealtimeTalkLaunch.ShowSetupMessage'],
  ['fun rememberChatRealtimeTalkLauncher(viewModel: MainViewModel): () -> Unit','fun rememberChatRealtimeTalkLauncher(viewModel: MainViewModel, nativeSpeech: Boolean = false): () -> Unit'],
  ['if (currentTalkSetup.requiresSetup) {','if (!nativeSpeech && currentTalkSetup.requiresSetup) {'],
  ['requiresSetup = talkSetupReadiness.realtimeTalk.requiresSetup,','requiresSetup = talkSetupReadiness.realtimeTalk.requiresSetup,\n        nativeSpeech = nativeSpeech,'],
]){if(talk.split(from).length!==2)throw new Error('Pinned native speech launcher context changed');talk=talk.replace(from,to);}
if(talk.split('viewModel.setTalkModeEnabled(true)').length!==3)throw new Error('Pinned Talk start callers changed');
talk=talk.replaceAll('viewModel.setTalkModeEnabled(true)','startTalk()');
talk=talk.replace('  val requestMicPermission =',
  '  val startTalk = { if (nativeSpeech) viewModel.startAnyLinkTalk() else viewModel.setTalkModeEnabled(true) }\n  val requestMicPermission =');
publish(talkPath,Buffer.from(talk));
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(item=>item.isDirectory()?walk(path.join(dir,item.name)):[path.join(dir,item.name)]);}
for(const file of walk(path.join(home,'overlay'))){const relative=path.relative(path.join(home,'overlay'),file);publish('apps/android/'+relative,fs.readFileSync(file));}
const assets=path.join(source,'apps/android/app/src/main/assets/anylink');fs.mkdirSync(assets,{recursive:true});
for(const name of ['portrait.html','avatar.js'])fs.copyFileSync(path.join(home,'web',name),path.join(assets,name));
const model=path.join(root,'data/mac/companion/model');
if(!fs.existsSync(path.join(model,'entry.model3.json')))throw new Error('Prepare the existing private character assets first.');
fs.cpSync(model,path.join(assets,'model'),{recursive:true});
for(const [from,name] of [['data/mac/companion/runtime/live2dcubismcore.min.js','live2dcubismcore.min.js'],['mac/companion/vendor/pixi.min.js','pixi.min.js'],['mac/companion/vendor/cubism4-colors.min.js','cubism4-colors.min.js']])fs.copyFileSync(path.join(root,from),path.join(assets,name));
const resource=path.join(source,'apps/android/app/src/main/res/drawable/anylink_avatar.png');fs.mkdirSync(path.dirname(resource),{recursive:true});fs.copyFileSync(path.join(root,'data/mac/branding/avatar.png'),resource);
const debug=path.join(source,'apps/android/app/src/debug/res');
for(const name of fs.readdirSync(path.join(source,'apps/android/app/src/main/res')).filter(n=>/^values(?:-|$)/.test(n))){
  const folder=path.join(debug,name);fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'anylink_brand.xml'),'<?xml version="1.0" encoding="utf-8"?><resources><string name="app_name">大肥鱼 · AnyLink</string></resources>\n');
}
for(const name of ['ic_launcher.xml','ic_launcher_round.xml']){
  const folder=path.join(debug,'mipmap-anydpi-v26');fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,name),'<?xml version="1.0" encoding="utf-8"?><adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@android:color/white"/><foreground android:drawable="@drawable/anylink_avatar"/></adaptive-icon>\n');
}
const licenses=path.join(source,'apps/android/THIRD_PARTY_LICENSES/openclaw/licenses');
for(const name of ['pixi-js-LICENSE.txt','pixi-live2d-display-LICENSE.txt','AIRI-LICENSE.txt'])fs.copyFileSync(path.join(root,'mac/companion/vendor',name),path.join(licenses,'AnyLink-'+name));
fs.copyFileSync(path.join(root,'mac/companion/ASSET-NOTICE.md'),path.join(licenses,'AnyLink-character-notice.txt'));
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
console.log('Prepared pinned official Android app with AnyLink portrait UI. No model or Gateway credentials copied.');
