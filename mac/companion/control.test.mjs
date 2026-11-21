import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {allowedControl,sendControl,validateControl} from './control.mjs';

test('only local main agent can change preferences; all actions use explicit bounded parameters',()=>{
  assert.equal(allowedControl({agentId:'main',channel:'webchat'},{action:'quiet'}),true);
  assert.equal(allowedControl({agentId:'main',channel:'slack'},{action:'status'}),false);
  assert.equal(allowedControl({agentId:'main',messageChannel:'slack'},{action:'status'}),false);
  assert.equal(allowedControl({agentId:'main',deliveryContext:{channel:'slack'}},{action:'status'}),false);
  assert.equal(allowedControl({agentId:'companion'},{action:'configure'}),false);
  assert.equal(allowedControl({agentId:'companion'},{action:'walk'}),true);
  for(const value of [{action:'exec'},{action:'quiet',minutes:-1},{action:'resize',scale:8},{action:'configure'},{action:'configure',roaming:'true'},{action:'show',url:'https://example.com'}])assert.throws(()=>validateControl(value));
  assert.deepEqual(validateControl({action:'configure',roaming:true,proactive:true,read_aloud:true}),{action:'configure',roaming:true,proactive:true,read_aloud:true});
});
test('private command bridge requires a live app epoch and reconciles identical calls from receipts',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'anylink-control-'));
  try{
    const ctx={agentId:'main',channel:'webchat',sessionKey:'fixture',runId:'run'};
    assert.equal((await sendControl(root,ctx,'offline',{action:'status'})).status,'desktop_unavailable');
    const folder=path.join(root,'data/mac/companion/control');fs.mkdirSync(path.join(folder,'receipts'),{recursive:true});
    fs.writeFileSync(path.join(folder,'presence.json'),JSON.stringify({enabled:true,epoch:'fixture',expires_at:Date.now()+30000}));
    const pending=sendControl(root,ctx,'same',{action:'quiet',minutes:60},{timeout:1000});
    const name=fs.readdirSync(path.join(folder,'requests'))[0],file=path.join(folder,'requests',name);
    assert.equal(fs.statSync(file).mode&0o777,0o600);
    const command=JSON.parse(fs.readFileSync(file));assert.equal(command.epoch,'fixture');assert.equal(command.expires_at-command.created_at,12000);
    const ack={status:'applied',applied:true,request_id:command.id};fs.writeFileSync(path.join(folder,'receipts',name),JSON.stringify(ack));fs.unlinkSync(file);
    assert.deepEqual(await pending,ack);
    assert.deepEqual(await sendControl(root,ctx,'same',{action:'quiet',minutes:60}),ack);
    assert.equal(fs.readdirSync(path.join(folder,'requests')).length,0,'An acknowledged tool call must not execute twice');
    assert.equal((await sendControl(root,ctx,'unknown',{action:'walk'},{timeout:100})).status,'result_unknown');
    assert.equal(fs.readdirSync(path.join(folder,'requests')).length,1,'An unknown result is left for status reconciliation, never resubmitted');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
