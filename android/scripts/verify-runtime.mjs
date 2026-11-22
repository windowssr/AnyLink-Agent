import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = vm.createContext({setTimeout, clearTimeout});
vm.runInContext(fs.readFileSync(path.join(root, 'core/polyfills.mjs'), 'utf8'), context);
const module = new vm.SourceTextModule(fs.readFileSync(path.join(root, 'runtime/pi-agent.js'), 'utf8'), {context});
await module.link(() => { throw new Error('The mobile runtime must be a self-contained bundle'); }); await module.evaluate();
context.Runtime = module.namespace;
const value = await vm.runInContext(`(async () => {
  let modelCalls = 0, toolCalls = 0;
  const model = {id:'test',name:'test',provider:'test',api:'openai-completions',input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000,reasoning:false,baseUrl:''};
  const agent = new Runtime.Agent({initialState:{model,systemPrompt:'Local runtime verification',tools:[{name:'local_status',label:'Local status',description:'Test local execution',parameters:{type:'object',properties:{},additionalProperties:false},execute:async()=>{toolCalls++;return{content:[{type:'text',text:'ok'}],details:{local:true}}}}]},streamFn:()=>{
    modelCalls++;const stream=new Runtime.AssistantMessageEventStream();const content=modelCalls===1?[{type:'toolCall',id:'local-1',name:'local_status',arguments:{}}]:[{type:'text',text:'done'}];
    const message={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,stopReason:modelCalls===1?'toolUse':'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});stream.end();return stream;
  }});
  await agent.prompt('Run a local tool');return {modelCalls,toolCalls,answer:agent.state.messages.at(-1).content[0].text,toolErrors:agent.state.messages.filter(m=>m.role==='toolResult'&&m.isError).map(m=>m.content),nodeGlobals:typeof process+':'+typeof Buffer+':'+typeof require};
})()`, context);
assert.equal(value.modelCalls, 2); assert.equal(value.toolCalls, 1, JSON.stringify(value.toolErrors)); assert.equal(value.answer, 'done'); assert.equal(value.nodeGlobals, 'undefined:undefined:undefined');
console.log('Mobile bundle completed a Pi tool round without process, Buffer, require, DOM or native Node modules.');
