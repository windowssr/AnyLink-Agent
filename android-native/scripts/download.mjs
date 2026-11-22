import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

/** Bounded, resumable HTTP ranges; the final official digest owns acceptance. */
export async function downloadPinned({url,sha256,sha1,bytes},target) {
  fs.mkdirSync(path.dirname(target),{recursive:true});
  // Google SDK repository metadata publishes SHA-1 for SDK package archives;
  // CLI/bootstrap tools and Gradle use their stronger published SHA-256 pins.
  const algorithm=sha256?'sha256':'sha1',expected=sha256??sha1;
  if(!new RegExp(`^[a-f0-9]{${algorithm==='sha256'?64:40}}$`).test(expected??''))throw new Error('A published artifact checksum is required');
  const digest=file=>createHash(algorithm).update(fs.readFileSync(file)).digest('hex');
  if(fs.existsSync(target)&&fs.statSync(target).size===bytes&&digest(target)===expected)return;
  const count=6,chunkSize=Math.ceil(bytes/count),chunks=[];
  // An interrupted standard downloader may already have a prefix. Reuse it
  // only as untrusted partial data; the complete published digest still gates use.
  if(fs.existsSync(target)&&fs.statSync(target).size<bytes&&!fs.existsSync(target+'.part-0')){
    const prefix=fs.readFileSync(target);
    for(let i=0;i<count;i++){const start=i*chunkSize;if(start>=prefix.length)break;fs.writeFileSync(target+'.part-'+i,prefix.subarray(start,Math.min(prefix.length,start+chunkSize)));}
  }
  const settled=await Promise.allSettled(Array.from({length:count},async(_,i)=>{
    const start=i*chunkSize,end=Math.min(bytes-1,start+chunkSize-1),size=end-start+1,file=target+'.part-'+i;chunks[i]=file;
    for(let attempt=0;attempt<8;attempt++){
      const have=fs.existsSync(file)?fs.statSync(file).size:0;
      if(have===size)return;
      if(have>size)throw new Error('Invalid partial download size');
      const temporary=file+'.receiving',headers=file+'.headers';
      const code=await new Promise((resolve,reject)=>{
        const child=spawn('/usr/bin/curl',['--fail','--location','--range',`${start+have}-${end}`,'--connect-timeout','15','--max-time','240','--silent','--show-error','--dump-header',headers,'--output',temporary,url],{stdio:['ignore','ignore','pipe']});
        child.stderr.on('data',()=>{});child.on('error',reject);child.on('exit',resolve);
      });
      const response=fs.existsSync(headers)?fs.readFileSync(headers,'utf8'):'';
      const range=[...response.matchAll(/content-range:\s*bytes\s+(\d+)-(\d+)\/(\d+)/ig)].at(-1);
      if(range&&+range[1]===start+have&&+range[3]===bytes&&fs.existsSync(temporary)){
        const received=fs.readFileSync(temporary);if(received.length>size-have)throw new Error('Oversized official download range');
        fs.appendFileSync(file,received);
      }
      for(const p of [temporary,headers])if(fs.existsSync(p))fs.rmSync(p);
      if(fs.existsSync(file)&&fs.statSync(file).size===size){console.log(`Official artifact range ${i+1}/${count} ready`);return;}
      if(code===0)throw new Error('Download endpoint did not return the requested byte range');
    }
    throw new Error('Partial artifact download preserved; rerun to resume');
  }));
  // Wait for every admitted range to settle before reporting a failure; leaving
  // child transfers behind could race the next resumable installation.
  const failed=settled.find(r=>r.status==='rejected');if(failed)throw failed.reason;
  const fd=fs.openSync(target,'w');try{for(const file of chunks)fs.writeSync(fd,fs.readFileSync(file));}finally{fs.closeSync(fd);}
  if(digest(target)!==expected)throw new Error('Official artifact checksum mismatch; download was not executed');
  for(const file of chunks)fs.rmSync(file);
}
