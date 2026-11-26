import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {root,tools} from './layout.mjs';
import {downloadPinned} from './download.mjs';
const directory=path.join(root,'data/android-native');
const archive=path.join(directory,'gradle-'+tools.gradle.version+'.zip');
const destination=path.join(directory,'gradle-distribution');
const installation=path.join(destination,'gradle-'+tools.gradle.version);
const receipt=path.join(installation,'anylink-verified.json');
let installed=false;try{installed=JSON.parse(fs.readFileSync(receipt)).sha256===tools.gradle.sha256;}catch{}
if(!installed){
  await downloadPinned(tools.gradle,archive);
  fs.mkdirSync(destination,{recursive:true});
  const staging=fs.mkdtempSync(path.join(destination,'.extract-'));
  try{
    execFileSync('/usr/bin/unzip',['-q',archive,'-d',staging]);
    const extracted=path.join(staging,'gradle-'+tools.gradle.version);
    if(!fs.existsSync(path.join(extracted,'lib/gradle-launcher-'+tools.gradle.version+'.jar')))throw new Error('Gradle distribution is incomplete');
    fs.writeFileSync(path.join(extracted,'anylink-verified.json'),JSON.stringify({sha256:tools.gradle.sha256,url:tools.gradle.url})+'\n');
    if(fs.existsSync(installation))fs.renameSync(installation,installation+'.incomplete-'+Date.now());
    fs.renameSync(extracted,installation);
  }finally{fs.rmSync(staging,{recursive:true,force:true});}
  fs.rmSync(archive);
}
console.log('Verified pinned Gradle is ready: '+path.relative(root,path.join(installation,'bin/gradle')));
