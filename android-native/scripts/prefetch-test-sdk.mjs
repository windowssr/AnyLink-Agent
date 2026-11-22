import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {root,tools} from './layout.mjs';
import {downloadPinned} from './download.mjs';
const spec=tools.robolectricSdk;
const directory=path.join(root,'data/android-native/maven-cache/org/robolectric/android-all-instrumented',spec.version);
fs.mkdirSync(directory,{recursive:true});
const jar=path.join(directory,'android-all-instrumented-'+spec.version+'.jar');
await downloadPinned(spec,jar);
const pom=jar.replace(/\.jar$/,'.pom');
if(!fs.existsSync(pom)||createHash('sha256').update(fs.readFileSync(pom)).digest('hex')!==spec.pomSha256){
  const temporary=pom+'.downloading';
  execFileSync('/usr/bin/curl',['--fail','--location','--silent','--show-error','--connect-timeout','10','--max-time','30','--output',temporary,spec.url.replace(/\.jar$/,'.pom')],{stdio:'inherit',timeout:40000});
  if(createHash('sha256').update(fs.readFileSync(temporary)).digest('hex')!==spec.pomSha256)throw new Error('Official test SDK POM checksum mismatch');
  fs.renameSync(temporary,pom);
}
console.log('Verified Android34 JVM test framework cache is ready; no emulator installed.');
