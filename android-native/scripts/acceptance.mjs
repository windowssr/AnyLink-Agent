import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {root,output} from './layout.mjs';
// This runs the actual native Kotlin Agent implementation, not a Gateway
// impersonation. Existing authorized preview identity only; no new credentials.
const connection=path.join(root,'secrets/android-preview-connection.json');
if(!fs.existsSync(connection))throw new Error('Prepare an authorized, separate Android preview credential first');
const marker='AL_DEVICE_'+randomUUID(),file=path.join(root,'data/mac/workspace',marker+'.txt');
const report=path.join(output,'independent-live-acceptance.json');
fs.mkdirSync(output,{recursive:true});fs.writeFileSync(file,'Independent native Android Agent read-only search proof\n',{mode:0o600,flag:'wx'});
try{
  const result=spawnSync(process.execPath,[path.join(root,'android-native/scripts/build.mjs'),'--live'],{cwd:root,stdio:'inherit',env:{...process.env,ANYLINK_LIVE_CONNECTION_FILE:connection,ANYLINK_LIVE_MARKER:marker,ANYLINK_LIVE_REPORT:report}});
  if(result.status!==0)throw new Error('Native live proof failed; inspect artifacts/android-native/live.log. No model/tool replay was attempted automatically.');
  const value=JSON.parse(fs.readFileSync(report));if(!value.passed)throw new Error('Native live proof did not confirm success');
  console.log(JSON.stringify({passed:true,checks:value.checks.length,hardware_verified:false,gateway_used:false}));
}finally{fs.rmSync(file,{force:true});}
