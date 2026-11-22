import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {downloadPinned} from '../scripts/download.mjs';
const bytes=Buffer.from(Array.from({length:120000},(_,i)=>i%251));
async function fixture(run){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anylink-pinned-download-'));
  const server=http.createServer((req,res)=>{
    const match=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range??'');
    if(!match){res.writeHead(416).end();return;}
    const start=Number(match[1]),end=Number(match[2]);
    res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Length':end-start+1});res.end(bytes.subarray(start,end+1));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await run(dir,'http://127.0.0.1:'+server.address().port+'/artifact.zip');}
  finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
}
test('pinned transfer resumes an untrusted prefix, validates the complete published digest and removes parts',async()=>fixture(async(dir,url)=>{
  const target=path.join(dir,'artifact.zip');fs.writeFileSync(target,bytes.subarray(0,27000));
  await downloadPinned({url,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},target);
  assert.deepEqual(fs.readFileSync(target),bytes);assert.deepEqual(fs.readdirSync(dir),['artifact.zip']);
}));
test('Google SDK SHA1 metadata is verified and a wrong published checksum is refused',async()=>fixture(async(dir,url)=>{
  const target=path.join(dir,'new-directory/artifact.zip');
  await downloadPinned({url,bytes:bytes.length,sha1:createHash('sha1').update(bytes).digest('hex')},target);
  assert.deepEqual(fs.readFileSync(target),bytes);
  await assert.rejects(downloadPinned({url,bytes:bytes.length,sha256:'0'.repeat(64)},path.join(dir,'refused.zip')),/checksum mismatch/);
}));
