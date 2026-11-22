import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {createServer} from 'node:http';import {spawn} from 'node:child_process';
test('portable Mac setup verifies identity and preserves an existing profile',{skip:process.platform!=='darwin'},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'anylink-mac-setup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'mac'));fs.mkdirSync(path.join(root,'sdk/src'),{recursive:true});
 for(const name of ['connect.mjs','configure.mjs'])fs.copyFileSync('mac/'+name,path.join(root,'mac',name));fs.copyFileSync('sdk/src/client.mjs',path.join(root,'sdk/src/client.mjs'));
 const id='00000000-0000-4000-8000-000000000009',token='ak_'+crypto.randomUUID().replaceAll('-','');
 fs.writeFileSync(path.join(root,'credential.json'),JSON.stringify({device_id:id,token}));
 const server=createServer((req,res)=>{assert.equal(req.headers.authorization,`Bearer ${token}`);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({device:{id}}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const url='http://127.0.0.1:'+server.address().port;
 async function run(){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,[path.join(root,'mac/connect.mjs'),'--server',url,'--credential-file',path.join(root,'credential.json')]);let output='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);p.on('error',reject);p.on('close',code=>resolve({code,output}));});}
 const first=await run();assert.equal(first.code,0,first.output);assert.equal(first.output.includes(token),false);
 const profile=fs.readFileSync(path.join(root,'data/mac/openclaw/openclaw.json'),'utf8');const connection=JSON.parse(fs.readFileSync(path.join(root,'secrets/mac-connection.json')));
 assert.equal(connection.ssh_host,null);assert.equal(connection.device_id,id);
 const second=await run();assert.equal(second.code,1);assert.match(second.output,/Preserving existing/);assert.equal(fs.readFileSync(path.join(root,'data/mac/openclaw/openclaw.json'),'utf8'),profile);
});
test('join mode connects two agents, reuses install_id on reconnect and never writes the key',{skip:process.platform!=='darwin'},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'anylink-mac-join-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'mac'));fs.mkdirSync(path.join(root,'sdk/src'),{recursive:true});
 for(const name of ['connect.mjs','configure.mjs'])fs.copyFileSync('mac/'+name,path.join(root,'mac',name));fs.copyFileSync('sdk/src/client.mjs',path.join(root,'sdk/src/client.mjs'));
 const joinKey='join-key-for-test-only-0123456789abcdef',deviceId='00000000-0000-4000-8000-000000000010';
 const agents={};let installs=[],adopted=null;
 const server=createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.method==='POST'&&req.url==='/edge/v1/device/install-id'){
   let body='';req.on('data',b=>body+=b);req.on('end',()=>{adopted=JSON.parse(body).install_id;res.end(JSON.stringify({device_id:deviceId,install_id:adopted}));});return;}
  if(req.method==='POST'&&req.url==='/edge/v1/connect'){
   let body='';req.on('data',b=>body+=b);req.on('end',()=>{const input=JSON.parse(body);installs.push(input.device.install_id);
    const id=input.agent.key==='mac-openclaw'?'00000000-0000-4000-8000-000000000011':'00000000-0000-4000-8000-000000000012';
    const token='ak_'+input.agent.key.replaceAll('-','_')+'_'+Math.random().toString(36).slice(2);
    agents[token]={device_id:deviceId,agent_id:id};
    res.statusCode=201;res.end(JSON.stringify({device_id:deviceId,agent_id:id,credential_id:'cred-'+input.agent.key,token,protocol:{name:'anylink',version:'2.0'}}));});
   return;}
  if(req.method==='GET'&&req.url==='/edge/v1/identity'){const who=agents[req.headers.authorization?.replace('Bearer ','')];if(!who){res.statusCode=401;res.end('{"error":{"code":"EDGE_AUTH_REQUIRED"}}');return;}res.end(JSON.stringify({device:{id:who.device_id},agent:{id:who.agent_id}}));return;}
  res.statusCode=404;res.end('{}');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const url='http://127.0.0.1:'+server.address().port,keyFile=path.join(root,'join-key');fs.writeFileSync(keyFile,joinKey+'\n',{mode:0o600});
 async function run(){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,[path.join(root,'mac/connect.mjs'),'--server',url,'--join-key-file',keyFile,'--name','Test Mac']);let output='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);p.on('error',reject);p.on('close',code=>resolve({code,output}));});}
 const first=await run();assert.equal(first.code,0,first.output);assert.equal(first.output.includes(joinKey),false);
 const connection=JSON.parse(fs.readFileSync(path.join(root,'secrets/mac-connection.json'),'utf8'));
 assert.equal(connection.install_id.startsWith('mac-'),true);assert.equal(connection.device_id,deviceId);
 assert.equal(connection.agent_id,'00000000-0000-4000-8000-000000000011');assert.equal(connection.worker.agent_id,'00000000-0000-4000-8000-000000000012');
 assert.equal(connection.token.startsWith('ak_'),true);assert.equal(connection.worker.token.startsWith('ak_'),true);
 assert.equal(fs.existsSync(path.join(root,'secrets/mac-peer-policy.json')),false);
 const second=await run();assert.equal(second.code,0,second.output);assert.equal(installs.length,4);assert.equal(installs[2],installs[0],'reconnect reuses install_id');
 const reconnected=JSON.parse(fs.readFileSync(path.join(root,'secrets/mac-connection.json'),'utf8'));assert.equal(reconnected.install_id,connection.install_id);assert.notEqual(reconnected.token,connection.token);
 assert.equal(JSON.stringify(connection).includes(joinKey),false);assert.equal(JSON.stringify(reconnected).includes(joinKey),false);
});
test('join mode adopts a legacy device token install_id before connecting agents',{skip:process.platform!=='darwin'},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'anylink-mac-adopt-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'mac'));fs.mkdirSync(path.join(root,'sdk/src'),{recursive:true});fs.mkdirSync(path.join(root,'secrets'),{recursive:true});
 for(const name of ['connect.mjs','configure.mjs'])fs.copyFileSync('mac/'+name,path.join(root,'mac',name));fs.copyFileSync('sdk/src/client.mjs',path.join(root,'sdk/src/client.mjs'));
 const legacyToken='ak_'+'y'.repeat(40),deviceId='00000000-0000-4000-8000-000000000020';
 fs.writeFileSync(path.join(root,'secrets/mac-connection.json'),JSON.stringify({server:'SERVER_URL',device_id:deviceId,token:legacyToken}));
 const order=[];
 const server=createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');let body='';req.on('data',b=>body+=b);req.on('end',()=>{
   if(req.method==='POST'&&req.url==='/edge/v1/device/install-id'){order.push('adopt');res.end(JSON.stringify({device_id:deviceId,install_id:JSON.parse(body).install_id}));return;}
   if(req.method==='POST'&&req.url==='/edge/v1/connect'){order.push('connect');const input=JSON.parse(body);const id='00000000-0000-4000-8000-00000000002'+(input.agent.key==='mac-openclaw'?'1':'2');const token='ak_new_'+input.agent.key;res.statusCode=201;res.end(JSON.stringify({device_id:deviceId,agent_id:id,credential_id:'c',token}));return;}
   if(req.method==='GET'&&req.url==='/edge/v1/identity'){res.end(JSON.stringify({device:{id:deviceId},agent:{id:req.headers.authorization.includes('openclaw')?'00000000-0000-4000-8000-000000000021':'00000000-0000-4000-8000-000000000022'}}));return;}
   res.statusCode=404;res.end('{}');});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const url='http://127.0.0.1:'+server.address().port,keyFile=path.join(root,'join-key');fs.writeFileSync(keyFile,'j'.repeat(32)+'\n',{mode:0o600});
 const run=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[path.join(root,'mac/connect.mjs'),'--server',url,'--join-key-file',keyFile]);let output='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);p.on('error',reject);p.on('close',code=>resolve({code,output}));});
 assert.equal(run.code,0,run.output);assert.deepEqual(order.slice(0,3),['adopt','connect','connect'],'legacy token adopts install_id before agent connects');
 const connection=JSON.parse(fs.readFileSync(path.join(root,'secrets/mac-connection.json'),'utf8'));
 assert.equal(connection.device_id,deviceId);assert.equal(connection.install_id.startsWith('mac-'),true);
});
