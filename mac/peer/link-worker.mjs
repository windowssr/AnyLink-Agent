import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {AnyLinkClient} from '../../sdk/src/client.mjs';
import {AnyLinkWorker} from '../../sdk/src/worker.mjs';
import {searchFiles} from './search.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export function createMacLinkWorker({connection,policyFile,journalPath}){
  const policy=()=>{
    const value=JSON.parse(fs.readFileSync(policyFile,'utf8'));
    if(value.device_id!==connection.device_id||!Array.isArray(value.roots)||!value.roots.length)throw new Error('Local Mac search policy is unavailable for this identity');
    return value;
  };
  policy();
  return new AnyLinkWorker({client:new AnyLinkClient({baseUrl:connection.server,token:connection.worker?.token??connection.token,timeoutMs:20000}),journalPath,
    handlers:{'files.search':{description:'Read-only filename search in Mac-owned roots; no file contents or shell',
      execute:(input,{signal})=>searchFiles(input,policy(),{signal})}}});
}
async function main(){
  const connection=JSON.parse(fs.readFileSync(path.join(root,'secrets/mac-connection.json'),'utf8'));
  const policyFile=path.join(root,'secrets/mac-peer-policy.json');
  // A missing local policy does not silently open new folders.
  if(!fs.existsSync(policyFile)){process.stdout.write('{"event":"link_worker_needs_local_search_policy"}\n');return;}
  const directory=path.join(root,'data/mac/link');fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const agentId=connection.worker?.agent_id,journal=agentId?`executions-${agentId}.sqlite`:'executions.sqlite';
  const worker=createMacLinkWorker({connection,policyFile,journalPath:path.join(directory,journal)});
  const abort=new AbortController();const stop=()=>abort.abort();process.on('SIGTERM',stop);process.on('SIGINT',stop);
  try{
    while(!abort.signal.aborted){
      try{await worker.recoverResults();await worker.run({signal:abort.signal,pollIntervalMs:2500});}
      catch{if(!abort.signal.aborted)process.stdout.write('{"event":"link_worker_connection_unavailable_no_execution_replay"}\n');}
      try{await delay(5000,undefined,{signal:abort.signal});}catch{}
    }
  }finally{worker.close();process.off('SIGTERM',stop);process.off('SIGINT',stop);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
