import fs from 'node:fs';
import path from 'node:path';
import {AnyLinkClient} from '../src/client.mjs';
import {AnyLinkWorker} from '../src/worker.mjs';
const directory=path.resolve(process.env.ANYLINK_STATE_DIR??'data/anylink-worker');fs.mkdirSync(directory,{recursive:true,mode:0o700});
let client;
if(process.env.ANYLINK_DEVICE_TOKEN){
  if(!process.env.ANYLINK_BASE_URL)throw new Error('Set ANYLINK_BASE_URL');
  client=new AnyLinkClient({baseUrl:process.env.ANYLINK_BASE_URL,token:process.env.ANYLINK_DEVICE_TOKEN});
}else if(process.env.ANYLINK_JOIN_KEY){
  if(!process.env.ANYLINK_BASE_URL)throw new Error('Set ANYLINK_BASE_URL');
  const joined=await AnyLinkClient.connect({baseUrl:process.env.ANYLINK_BASE_URL,joinKey:process.env.ANYLINK_JOIN_KEY,
    installId:process.env.ANYLINK_INSTALL_ID??'anylink-worker-'+path.basename(directory),
    device:{name:process.env.ANYLINK_DEVICE_NAME??'AnyLink worker',platform:'other'},
    agent:{key:process.env.ANYLINK_AGENT_KEY??'worker',name:process.env.ANYLINK_AGENT_NAME??'AnyLink worker'}});
  client=new AnyLinkClient({baseUrl:process.env.ANYLINK_BASE_URL,token:joined.token});
}else throw new Error('Set ANYLINK_DEVICE_TOKEN, or ANYLINK_BASE_URL with ANYLINK_JOIN_KEY to connect');
const worker=new AnyLinkWorker({client,journalPath:path.join(directory,'receipts.sqlite'),handlers:{
  'text.reverse':{description:'Reverse supplied text without reading files or executing commands',async execute(input,{signal}){signal.throwIfAborted();if(typeof input.text!=='string'||input.text.length>10000)throw new Error('Invalid text');return {text:[...input.text].reverse().join('')};}},
}});
const stop=new AbortController();for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>stop.abort());
try{await worker.recoverResults();await worker.run({signal:stop.signal});}finally{worker.close();}
