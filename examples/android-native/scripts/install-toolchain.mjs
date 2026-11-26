import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawn} from 'node:child_process';
import {root, tools, sdk, output, environment} from './layout.mjs';
import {downloadPinned} from './download.mjs';
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This pinned toolchain is for the current Apple Silicon Mac.');
if (!process.argv.includes('--accept-sdk-license')) throw new Error('Google SDK license acceptance is required. Read toolchain-lock.json before using --accept-sdk-license.');
if (!fs.existsSync(path.join(tools.javaHome, 'bin/java'))) throw new Error('The configured existing JDK 17 is missing.');
fs.mkdirSync(output, {recursive:true}); fs.mkdirSync(sdk, {recursive:true});
if (fs.statfsSync(root).bavail * fs.statfsSync(root).bsize < 4 * 1024 ** 3) throw new Error('At least 4 GiB free is required for this first build.');
const manager = path.join(sdk, 'cmdline-tools/latest/bin/sdkmanager');
if (!fs.existsSync(manager)) {
  const archive = path.join(root, 'data/android-native/command-line-tools.zip');
  await downloadPinned(tools.commandLineTools,archive);
  const unpack = path.join(root, 'data/android-native/command-line-tools'); fs.mkdirSync(unpack, {recursive:true});
  execFileSync('/usr/bin/unzip', ['-q',archive,'-d',unpack]);
  fs.mkdirSync(path.dirname(path.dirname(manager)), {recursive:true});
  fs.renameSync(path.join(unpack,'cmdline-tools'),path.join(sdk,'cmdline-tools/latest'));
  fs.rmSync(unpack,{recursive:true}); fs.rmSync(archive);
}
const log = fs.openSync(path.join(output, 'sdk-install.log'), 'a');
console.log('Installing only Android platform 37, build tools and platform tools; SDK license acceptance was explicitly authorized.');
await new Promise((resolve,reject) => {
  const child = spawn(manager, ['--sdk_root='+sdk,...tools.sdkPackages], {env:environment(),stdio:['pipe',log,log]});
  child.stdin.on('error',()=>{}); child.stdin.end('y\n'.repeat(8));
  child.on('error',reject); child.on('exit',code => code === 0 ? resolve() : reject(new Error('SDK install failed; inspect artifacts/android-native/sdk-install.log.')));
});
fs.closeSync(log);
fs.writeFileSync(path.join(root,'data/android-native/sdk-consent.json'),JSON.stringify({license:tools.license,tools_revision:tools.commandLineTools.revision,accepted_for_requested_build:true,at:new Date().toISOString()},null,2)+'\n',{mode:0o600});
console.log('Android SDK is ready inside this project.');
