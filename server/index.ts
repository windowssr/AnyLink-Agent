import { createApp } from './app.js';
import { loadConfig } from './config.js';
const config=loadConfig();
const {app}=await createApp(config);
await app.listen({host:config.host,port:config.port});
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{
  if(stopping)return;stopping=true;
  void app.close().then(()=>{process.exitCode=0;},()=>{process.exitCode=1;});
});
