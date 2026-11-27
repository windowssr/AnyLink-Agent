import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {root,home,sdk,output,environment,lock} from './layout.mjs';
const privateMode=process.argv.includes('--private');
const version=JSON.parse(fs.readFileSync(path.join(home,'package.json'))).version;
const apk=path.join(output,'AnyLink-Android-'+version+(privateMode?'-private':'')+'.apk');
const buildTools=path.join(sdk,'build-tools/37.0.0');
const badging=execFileSync(path.join(buildTools,'aapt'),['dump','badging',apk],{env:environment(),encoding:'utf8'});
assert.ok(badging.includes("package: name='com.anylink.agent.debug'"));
assert.ok(badging.includes("launchable-activity: name='ai.openclaw.app.anylink.AnyLinkActivity'"));
assert.ok(badging.includes("sdkVersion:'31'"));
assert.ok(badging.includes("targetSdkVersion:'36'"));
assert.ok(badging.includes("application-label:'大肥鱼 · AnyLink'"));
for(const permission of ['READ_SMS','SEND_SMS','READ_CALL_LOG','ACCESS_BACKGROUND_LOCATION','READ_MEDIA_IMAGES','CAMERA'])assert.ok(!badging.includes("uses-permission: name='android.permission."+permission+"'"),'Unexpected legacy phone permission '+permission);
const manifest=execFileSync(path.join(buildTools,'aapt'),['dump','xmltree',apk,'AndroidManifest.xml'],{encoding:'utf8'});
for(const component of ['ai.openclaw.app.MainActivity','NodeForegroundService','VoiceE2eReceiver','VoiceE2eService','OpenClawAccessibilityService'])assert.ok(!manifest.includes(component),'Legacy component is still registered: '+component);
for(const permission of ['SYSTEM_ALERT_WINDOW','FOREGROUND_SERVICE','FOREGROUND_SERVICE_SPECIAL_USE','FOREGROUND_SERVICE_MICROPHONE','POST_NOTIFICATIONS'])assert.ok(badging.includes("uses-permission: name='android.permission."+permission+"'"),'Missing required permission '+permission);
for(const component of ['ai.openclaw.app.anylink.AnyLinkCompanionService','ai.openclaw.app.anylink.AnyLinkAccessibilityService'])assert.ok(manifest.includes(component),'Missing component '+component);
assert.ok(manifest.includes('PROPERTY_SPECIAL_USE_FGS_SUBTYPE'),'Missing specialUse FGS subtype property');
assert.ok(manifest.includes('"android.accessibilityservice"'),'Missing accessibility service meta-data');

const signature=execFileSync('/bin/sh',[path.join(buildTools,'apksigner'),'verify','--verbose','--print-certs',apk],{env:environment(),encoding:'utf8'});
const buildInfo=JSON.parse(execFileSync('/usr/bin/unzip',['-p',apk,'assets/anylink/build-info.json'],{encoding:'utf8'}));
assert.equal(buildInfo.architecture,'device-agent');assert.equal(buildInfo.gateway_required,false);
assert.equal(buildInfo.upstream,lock.commit);assert.equal(buildInfo.version,version);
assert.equal(buildInfo.source,execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim());
// Inspect decompressed entries, including DEX strings. Searching the compressed
// APK bytes alone would miss a credential accidentally copied into an asset.
const scan=JSON.parse(execFileSync('python3',['-c',`
import sys,zipfile,json,re
from pathlib import Path
root=Path(sys.argv[1]); private_mode=sys.argv[3]=='1'; tokens=[]
for name in ['mac-connection.json','android-preview-connection.json']:
 p=root/'secrets'/name
 if p.exists(): tokens.append(json.loads(p.read_text())['token'].encode())
p=root/'secrets/mac-gateway-token'
if p.exists(): tokens.append(p.read_bytes().strip())
bad=[]
with zipfile.ZipFile(sys.argv[2]) as z:
 names=z.namelist()
 for name in names:
  data=z.read(name)
  if '/secrets/' in name or any(t and t in data for t in tokens) or re.search(rb'sk-[a-zA-Z0-9]{24,}',data): bad.append(name)
 if private_mode:
  assert 'assets/anylink/model/entry.model3.json' in names, 'Private APK is missing the Live2D model'
  assert any('live2dcubismcore' in n.lower() for n in names), 'Private APK is missing the Cubism core'
  assert 'assets/anylink/avatar.js' in names
  assert 'assets/anylink/avatar-loader.js' in names, 'Private APK is missing the startup monitor'
  assert any('anylink_portrait' in n and n.endswith('.png') for n in names), 'Private APK must use the private character fallback'
  assert not any('anylink_portrait' in n and n.endswith('.xml') for n in names), 'Private APK must not use the public robot fallback'
  model_entries = [n for n in names if n.startswith('assets/anylink/model/')]
  assert all(n.isascii() for n in model_entries), f'Non-ASCII Live2D asset paths found: {[n for n in model_entries if not n.isascii()]}'
  model_json = json.loads(z.read('assets/anylink/model/entry.model3.json').decode('utf-8'))
  refs = model_json.get('FileReferences', {})
  expected_refs = []
  for k in ('Moc', 'Physics', 'DisplayInfo'):
   if refs.get(k): expected_refs.append(refs[k])
  expected_refs.extend(refs.get('Textures', []))
  for grp in (refs.get('Motions') or {}).values():
   for m in grp:
    if m.get('File'): expected_refs.append(m['File'])
  for exp in (refs.get('Expressions') or []):
   if exp.get('File'): expected_refs.append(exp['File'])
  missing = [r for r in expected_refs if ('assets/anylink/model/' + r) not in names]
  assert not missing, f'Private APK missing Live2D referenced assets: {missing}'
 else:
  assert not any(n.endswith('.moc3') or 'live2dcubismcore' in n.lower() or '/anylink/model/' in n for n in names), 'Restricted character assets found in public APK'
  assert not any('anylink_avatar' in n and n.endswith('.png') for n in names), 'Private derived avatar found in public APK'
  assert not any('anylink_portrait' in n and n.endswith('.png') for n in names), 'Private derived portrait found in public APK'
  assert 'assets/anylink/public-avatar.js' in names
 assert 'assets/anylink/portrait.html' in names
 assert 'assets/anylink/favicon.svg' in names, 'Missing bundled avatar favicon'
 assert json.loads(z.read('assets/anylink/offline-asr.json')) == json.loads((root/'examples/android-native/offline-asr-lock.json').read_text()), 'Offline ASR model pins differ from source'
 assert not any(n.startswith('assets/anylink/') and n.endswith('.onnx') for n in names), 'Offline ASR model should be downloaded separately'
 for abi in ('arm64-v8a','armeabi-v7a','x86','x86_64'):
  assert f'lib/{abi}/libsherpa-onnx-jni.so' in names, f'Missing local speech runtime for {abi}'
 for license_name in ('sherpa-onnx-Apache-2.0.txt','onnxruntime-MIT.txt','offline-asr-model.txt'):
  assert any(n.endswith('AnyLink-'+license_name) for n in names), f'Missing offline speech notice: {license_name}'
 for cue in ('anylink_call_start.wav', 'anylink_call_end.wav'):
  assert any(n.endswith('/'+cue) for n in names), f'Missing call cue: {cue}'
 print(json.dumps({'entries':len(names),'credential_matches':bad}))
`,root,apk,privateMode?'1':'0'],{encoding:'utf8',maxBuffer:1024*1024}));
assert.deepEqual(scan.credential_matches,[]);
assert.equal(buildInfo.private_character,privateMode,'APK character mode does not match the requested distribution');
const report={version,application_id:'com.anylink.agent.debug',min_sdk:31,target_sdk:36,bytes:fs.statSync(apk).size,sha256:createHash('sha256').update(fs.readFileSync(apk)).digest('hex'),...buildInfo,signature:signature.trim(),scan,verified_at:new Date().toISOString(),hardware_verified:false};
fs.writeFileSync(path.join(output,'apk-inspection.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({verified:true,apk:path.relative(root,apk),sha256:report.sha256,bytes:report.bytes,entries:scan.entries,hardware_verified:false}));
