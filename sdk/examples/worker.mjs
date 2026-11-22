import fs from 'node:fs';
import path from 'node:path';
import {AnyLinkClient} from '../src/client.mjs';
import {AnyLinkWorker} from '../src/worker.mjs';
if(!process.env.ANYLINK_BASE_URL||!process.env.ANYLINK_DEVICE_TOKEN)throw new Error('Set ANYLINK_BASE_URL and ANYLINK_DEVICE_TOKEN');
const client=new AnyLinkClient({baseUrl:process.env.ANYLINK_BASE_URL,token:process.env.ANYLINK_DEVICE_TOKEN});
const directory=path.resolve(process.env.ANYLINK_STATE_DIR??'data/anylink-worker');fs.mkdirSync(directory,{recursive:true,mode:0o700});
const worker=new AnyLinkWorker({client,journalPath:path.join(directory,'receipts.sqlite'),handlers:{
  'text.reverse':{description:'Reverse supplied text without reading files or executing commands',async execute(input,{signal}){signal.throwIfAborted();if(typeof input.text!=='string'||input.text.length>10000)throw new Error('Invalid text');return {text:[...input.text].reverse().join('')};}},
}});
const stop=new AbortController();for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>stop.abort());
try{await worker.recoverResults();await worker.run({signal:stop.signal});}finally{worker.close();}
