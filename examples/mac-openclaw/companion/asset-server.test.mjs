import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';

test('asset host limits access to scoped read-only files and exits with parent stdin',{timeout:5000},async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'anylink-avatar-'));
  const roots=await Promise.all(['web','model','core'].map(async name=>{const dir=path.join(home,name);await fs.mkdir(dir);return dir;}));
  await fs.writeFile(path.join(roots[0],'index.html'),'<html>avatar</html>');
  await fs.writeFile(path.join(home,'private.txt'),'outside');
  await fs.symlink(path.join(home,'private.txt'),path.join(roots[0],'escape.txt'));
  const token=randomBytes(32).toString('hex');
  const child=spawn(process.execPath,[new URL('./asset-server.mjs',import.meta.url).pathname,...roots],{env:{...process.env,ANYLINK_AVATAR_ASSET_TOKEN:token},stdio:['pipe','pipe','pipe']});
  try{
    const [chunk]=await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('Asset host could not bind loopback. Run this test with local network permission.');})]);
    const {url}=JSON.parse(chunk.toString()),base=new URL(url).origin;
    const page=await fetch(url);assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/media-src 'none'/);assert.equal(await page.text(),'<html>avatar</html>');
    assert.equal((await fetch(url,{method:'HEAD'})).status,200);
    for(const suffix of ['/wrong/web/index.html',`/${token}/web/escape.txt`,`/${token}/web/`,`/${token}/private.txt`,`/${token}/web/%2e%2e%2fprivate.txt`])assert.equal((await fetch(base+suffix)).status,404);
    assert.equal((await fetch(url,{method:'POST',body:'no'})).status,405);
    const ended=once(child,'exit');child.stdin.end();await ended;
    await assert.rejects(fetch(url));
  }finally{if(child.exitCode===null)child.kill();await fs.rm(home,{recursive:true,force:true});}
});
