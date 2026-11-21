import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {controlStatus,bridgeSocket} from './client.mjs';

async function fixture(fn){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'anylink-control-status-'));
  try{
    fs.mkdirSync(path.join(root,'data/mac/control'),{recursive:true});fs.mkdirSync(path.join(root,'mac/control'),{recursive:true});
    fs.writeFileSync(path.join(root,'data/mac/control/control.json'),'{"enabled":true}');
    fs.writeFileSync(path.join(root,'mac/control/versions.json'),JSON.stringify({version:'fixture',sourceCommit:'pinned'}));
    await fn(root);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}
const timeout={success:false,error:{code:'BRIDGE_UNAVAILABLE',message:'Bridge diagnostic handshake timed out after 1.0s'}};
const host={success:true,data:{selected:{source:'remote',socketPath:bridgeSocket,handshake:{hostIdentity:{bundleIdentifier:'boo.peekaboo.mac',bundleShortVersion:'fixture',sourceCommit:'pinned'}}}}};
test('only bounded read-only diagnostic timeouts retry, with identity and permissions still required',()=>fixture(async root=>{
  let probes=0;const operations=[];
  const status=await controlStatus(root,async args=>{
    operations.push(args.join(' '));
    if(args[0]==='bridge')return ++probes<3?timeout:host;
    return {success:true,data:{source:'bridge',permissions:[{name:'Screen Recording',isGranted:true,isRequired:true},{name:'Accessibility',isGranted:true,isRequired:true}]}};
  });
  assert.equal(status.ready,true);assert.equal(probes,3);assert.deepEqual(operations,['bridge status','bridge status','bridge status','permissions status']);
  let attempts=0;assert.equal((await controlStatus(root,async()=>{attempts++;return timeout;})).ready,false);assert.equal(attempts,5);
}));
test('wrong host identity and explicit trust failures never fall back or retry',()=>fixture(async root=>{
  let calls=0;const wrong={success:true,data:{selected:{...host.data.selected,socketPath:'/tmp/other-host.sock'}}};
  assert.equal((await controlStatus(root,async()=>{calls++;return wrong;})).ready,false);assert.equal(calls,1);
  calls=0;assert.equal((await controlStatus(root,async()=>{calls++;return {success:false,error:{code:'AUTHENTICATION_FAILED'}};})).ready,false);assert.equal(calls,1);
}));
