import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {AnyLinkClient} from '../../sdk/src/client.mjs';
import {AnyLinkWorker, TaskFailure} from '../../sdk/src/worker.mjs';
import {searchFiles, PeerFailure} from './search.mjs';
import {createAgentAskHandler} from './agent-ask.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const filesSearch=async(input,{signal},policy)=>{try{return await searchFiles(input,policy(),{signal});}catch(e){if(e instanceof PeerFailure)throw new TaskFailure(e.code,e.message);throw e;}};
export function createMacLinkWorker({connection,policyFile,journalPath}){
  const policy=()=>{
    const value=JSON.parse(fs.readFileSync(policyFile,'utf8'));
    if(value.device_id!==connection.device_id||!Array.isArray(value.roots)||!value.roots.length)throw new Error('Local Mac search policy is unavailable for this identity');
    return value;
  };
  policy();
  return new AnyLinkWorker({client:new AnyLinkClient({baseUrl:connection.server,token:connection.worker?.token??connection.token,timeoutMs:20000}),journalPath,
    handlers:{'files.search':{description:'Read-only filename search in Mac-owned roots; no file contents or shell',execute:(input,context)=>filesSearch(input,context,policy)}}});
}
// The mac-openclaw agent answers agent.ask by driving the local OpenClaw remote agent.
export function createMacAskWorker({connection,journalPath,gatewayToken,gatewayUrl,fetchImpl}){
  const client=new AnyLinkClient({baseUrl:connection.server,token:connection.token,timeoutMs:20000});
  return new AnyLinkWorker({client,journalPath,
    handlers:{'agent.ask':createAgentAskHandler({client,gatewayToken,gatewayUrl,fetchImpl})}});
}
async function loop(worker,abort){
  while(!abort.signal.aborted){
    try{await worker.recoverResults();await worker.run({signal:abort.signal,pollIntervalMs:2500});}
    catch{if(!abort.signal.aborted)process.stdout.write('{"event":"link_worker_connection_unavailable_no_execution_replay"}\n');}
    try{await delay(5000,undefined,{signal:abort.signal});}catch{}
  }
}
async function main(){
  const connection=JSON.parse(fs.readFileSync(path.join(root,'secrets/mac-connection.json'),'utf8'));
  const policyFile=path.join(root,'secrets/mac-peer-policy.json');
  // A missing local policy does not silently open new folders.
  if(!fs.existsSync(policyFile)){process.stdout.write('{"event":"link_worker_needs_local_search_policy"}\n');return;}
  const directory=path.join(root,'data/mac/link');fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const agentId=connection.worker?.agent_id,journal=agentId?`executions-${agentId}.sqlite`:'executions.sqlite';
  const workers=[createMacLinkWorker({connection,policyFile,journalPath:path.join(directory,journal)})];
  if(connection.agent_id&&connection.worker){
    const gatewayToken=fs.readFileSync(path.join(root,'secrets/mac-gateway-token'),'utf8').trim();
    workers.push(createMacAskWorker({connection,journalPath:path.join(directory,`executions-${connection.agent_id}.sqlite`),gatewayToken}));
  }
  const abort=new AbortController();const stop=()=>abort.abort();process.on('SIGTERM',stop);process.on('SIGINT',stop);
  try{await Promise.all(workers.map(w=>loop(w,abort).finally(()=>w.close())));}
  finally{process.off('SIGTERM',stop);process.off('SIGINT',stop);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
