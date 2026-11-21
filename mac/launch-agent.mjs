import fs from 'node:fs';
import path from 'node:path';
import {paths} from './configure.mjs';
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const args=[path.join(paths.runtime,'node_modules/node/bin/node'),path.join(paths.root,'mac/start.mjs')];
const plist=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.anylink.openclaw</string><key>ProgramArguments</key><array>${args.map(s=>'<string>'+esc(s)+'</string>').join('')}</array><key>WorkingDirectory</key><string>${esc(paths.root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>ExitTimeOut</key><integer>360</integer><key>StandardOutPath</key><string>${esc(path.join(paths.root,'data/mac/logs/service.log'))}</string><key>StandardErrorPath</key><string>${esc(path.join(paths.root,'data/mac/logs/error.log'))}</string></dict></plist>\n`;
fs.mkdirSync(path.join(paths.root,'data/mac'),{recursive:true});fs.writeFileSync(path.join(paths.root,'data/mac/com.anylink.openclaw.plist'),plist,{mode:0o600});console.log('Prepared the private local LaunchAgent definition.');
