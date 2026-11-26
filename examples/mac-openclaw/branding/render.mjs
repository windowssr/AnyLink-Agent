import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import {spawn,execFileSync} from 'node:child_process';
import {paths} from '../configure.mjs';

const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'anylink-brand-render-'));
const output=path.join(paths.root,'data/mac/branding'),web=path.join(temporary,'web');
let server;
try{
  fs.mkdirSync(path.join(web,'vendor'),{recursive:true});
  for(const name of ['pixi.min.js','cubism4-colors.min.js'])fs.copyFileSync(path.join(paths.root,'examples/mac-openclaw/companion/vendor',name),path.join(web,'vendor',name));
  fs.copyFileSync(path.join(paths.root,'examples/mac-openclaw/branding/render.html'),path.join(web,'index.html'));fs.copyFileSync(path.join(paths.root,'examples/mac-openclaw/branding/render.js'),path.join(web,'render.js'));
  const binary=path.join(temporary,'render');
  const info=path.join(temporary,'Info.plist');fs.writeFileSync(info,'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.anylink.brand-render</string><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>');
  execFileSync('/usr/bin/xcrun',['swiftc','-parse-as-library','-swift-version','5','-module-cache-path',path.join(temporary,'module-cache'),path.join(paths.root,'examples/mac-openclaw/branding/Render.swift'),'-o',binary,'-framework','AppKit','-framework','WebKit','-Xlinker','-sectcreate','-Xlinker','__TEXT','-Xlinker','__info_plist','-Xlinker',info],{stdio:'inherit'});
  server=spawn(path.join(paths.runtime,'node_modules/node/bin/node'),[path.join(paths.root,'examples/mac-openclaw/companion/asset-server.mjs'),web,path.join(paths.root,'data/mac/companion/model'),path.join(paths.root,'data/mac/companion/runtime')],{env:{ANYLINK_AVATAR_ASSET_TOKEN:crypto.randomBytes(32).toString('hex')},stdio:['pipe','pipe','inherit']});
  const lines=readline.createInterface({input:server.stdout});
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Local model host did not start')),10000);lines.once('line',line=>{clearTimeout(timer);try{resolve(JSON.parse(line).url);}catch(error){reject(error);}});server.once('error',reject);});
  execFileSync(binary,[output],{input:url,stdio:['pipe','inherit','inherit'],timeout:50000});
}finally{server?.stdin.end();server?.kill('SIGTERM');fs.rmSync(temporary,{recursive:true,force:true});}
