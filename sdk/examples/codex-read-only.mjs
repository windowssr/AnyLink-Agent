import {spawn} from 'node:child_process';
import fs from 'node:fs';
/** Register as a handler on your own SDK worker. This starts a separate CLI turn. */
export function codexReadOnlyHandler({workspace,executable='codex'}){
  const cwd=fs.realpathSync(workspace);
  return {description:'Run Codex with a filesystem read-only sandbox; connector policy remains operator configured',async execute(input,{signal}){
    if(typeof input.prompt!=='string'||input.prompt.length<1||input.prompt.length>12000)throw new Error('Invalid prompt');
    signal.throwIfAborted();
    return await new Promise((resolve,reject)=>{
      const child=spawn(executable,['exec','--sandbox','read-only','--json','--cd',cwd,'-'],{cwd,stdio:['pipe','pipe','pipe'],signal});
      let output='',settled=false,killTimer;
      const stop=()=>{child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),5000);killTimer.unref();};
      const timer=setTimeout(stop,120000);
      const finish=(failure,value)=>{if(settled)return;settled=true;clearTimeout(timer);failure?reject(failure):resolve(value);};
      signal.addEventListener('abort',stop,{once:true});
      child.stdout.on('data',b=>{if(settled)return;output+=b;if(Buffer.byteLength(JSON.stringify({events:output}))>60000){stop();finish(new Error('Output exceeds the protocol payload budget'));}});
      child.stderr.resume();
      child.on('error',e=>finish(e));child.on('close',code=>{clearTimeout(killTimer);signal.removeEventListener('abort',stop);code===0?finish(null,{events:output}):finish(new Error('Codex failed; inspect local host logs'));});
      child.stdin.end(input.prompt);
    });
  }};
}
