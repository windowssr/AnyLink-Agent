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
