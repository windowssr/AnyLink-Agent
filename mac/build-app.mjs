import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

if(process.platform!=='darwin')throw new Error('Build AnyLink.app on macOS with Xcode Command Line Tools.');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(fs.readFileSync(path.join(root,'mac/desktop/version.json'),'utf8'));
const profile=path.join(root,'data/mac/openclaw/openclaw.json');
if(fs.existsSync(profile)&&JSON.parse(fs.readFileSync(profile,'utf8')).gateway?.controlUi?.basePath!=='/openclaw'){
  throw new Error('Prepare the existing Mac profile while idle: node mac/configure-desktop.mjs');
}
const output=path.join(root,'artifacts/desktop');
const app=path.join(output,'AnyLink.app');
const resources=path.join(app,'Contents/Resources');
const binaries=path.join(app,'Contents/MacOS');
const cache=path.join(output,'swift-module-cache');
const architecture=process.arch==='arm64'?'arm64':process.arch==='x64'?'x86_64':null;
if(!architecture)throw new Error('Unsupported Mac architecture.');
const run=(executable,args)=>execFileSync(executable,args,{stdio:'inherit',cwd:root});
fs.rmSync(app,{recursive:true,force:true});
for(const dir of [resources,binaries,cache])fs.mkdirSync(dir,{recursive:true});
const compilerArgs=['-swift-version','5','-O','-module-cache-path',cache,'-target',`${architecture}-apple-macosx${version.minimumMacOS}`];
run('/usr/bin/xcrun',['swiftc',...compilerArgs,'-parse-as-library','mac/desktop/App.swift','-o',path.join(binaries,'AnyLink'),'-framework','AppKit','-framework','WebKit']);
const render=path.join(output,'render-icon');
run('/usr/bin/xcrun',['swiftc',...compilerArgs,'mac/desktop/Icon.swift','-o',render,'-framework','AppKit']);
const iconPNG=path.join(output,'AnyLink.png');run(render,[iconPNG]);
const iconset=path.join(output,'AnyLink.iconset');fs.mkdirSync(iconset,{recursive:true});
for(const size of [16,32,128,256,512])for(const scale of [1,2]){
  run('/usr/bin/sips',['-z',String(size*scale),String(size*scale),iconPNG,'--out',path.join(iconset,`icon_${size}x${size}${scale===2?'@2x':''}.png`)]);
}
run('/usr/bin/iconutil',['-c','icns',iconset,'-o',path.join(resources,'AnyLink.icns')]);
fs.writeFileSync(path.join(resources,'desktop.json'),JSON.stringify({projectRoot:root},null,2)+'\n');
const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const revision=execFileSync('git',['rev-parse','--short=12','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const plist=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.anylink.desktop</string>
<key>CFBundleName</key><string>AnyLink</string>
<key>CFBundleDisplayName</key><string>AnyLink</string>
<key>CFBundleExecutable</key><string>AnyLink</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>AnyLink.icns</string>
<key>CFBundleShortVersionString</key><string>${xml(version.version)}</string>
<key>CFBundleVersion</key><string>${xml(version.version)}</string>
<key>AnyLinkSourceRevision</key><string>${xml(revision)}</string>
<key>LSMinimumSystemVersion</key><string>${xml(version.minimumMacOS)}</string>
<key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>\n`;
fs.writeFileSync(path.join(app,'Contents/Info.plist'),plist);
run('/usr/bin/plutil',['-lint',path.join(app,'Contents/Info.plist')]);
run('/usr/bin/codesign',['--force','--sign','-',app]);
run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
console.log(`Built ${app} (${architecture}, desktop ${version.version}). No runtime credentials are bundled.`);
