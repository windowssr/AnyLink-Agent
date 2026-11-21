export type ToolCall = { id:string; type:'function'; function:{name:string;arguments:string} };
export type GatewayMessage = {role:string;content:string|null;tool_calls?:ToolCall[];tool_call_id?:string};
export class GatewayError extends Error { constructor(public code:string) {super(code);} }
export async function* sseData(stream:ReadableStream<Uint8Array>):AsyncGenerator<string> {
  const reader=stream.getReader(),decoder=new TextDecoder(); let buffer='';let data:string[]=[];
  function line(value:string):string|undefined {
    if(value==='') { if(!data.length) return; const event=data.join('\n');data=[];return event; }
    if(value.startsWith('data:')) data.push(value.slice(5).replace(/^ /,''));
  }
  try {
    while(true) {
      const {done,value}=await reader.read();
      if(done) {buffer+=decoder.decode();break;}
      buffer+=decoder.decode(value,{stream:true});
      let pos:number;
      while((pos=buffer.indexOf('\n'))>=0) {const next=buffer.slice(0,pos).replace(/\r$/,'');buffer=buffer.slice(pos+1);const event=line(next);if(event!==undefined) yield event;}
    }
    if(buffer) {const event=line(buffer.replace(/\r$/,''));if(event!==undefined) yield event;}
    const tail=line('');if(tail!==undefined) yield tail;
  } finally {reader.releaseLock();}
}
export async function gatewayRound(params:{url:string;token:string;sessionKey:string;messages:GatewayMessage[];tools:unknown[];signal:AbortSignal;onDelta:(text:string)=>void}) {
  const response=await fetch(`${params.url}/v1/chat/completions`,{
    method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${params.token}`,'x-openclaw-session-key':params.sessionKey},
    body:JSON.stringify({model:'openclaw/default',stream:true,messages:params.messages,tools:params.tools,tool_choice:'auto',max_completion_tokens:2048}),signal:params.signal,
  });
  if(!response.ok) {await response.body?.cancel();throw new GatewayError(`GATEWAY_HTTP_${response.status}`);}
  if(!response.body) throw new GatewayError('GATEWAY_EMPTY_STREAM');
  let content='',finish:string|undefined,done=false;
  const calls=new Map<number,ToolCall>();
  for await(const data of sseData(response.body)) {
    if(data==='[DONE]') {done=true;break;}
    let event:any;try {event=JSON.parse(data);}catch {throw new GatewayError('GATEWAY_INVALID_STREAM');}
    if(event.error) throw new GatewayError('GATEWAY_RUN_FAILED');
    const choice=event.choices?.[0];if(!choice) continue;
    if(choice.delta?.content) {content+=choice.delta.content;params.onDelta(choice.delta.content);}
    for(const part of choice.delta?.tool_calls ?? []) {
      const index=part.index??0;
      const call=calls.get(index)??{id:'',type:'function' as const,function:{name:'',arguments:''}};
      if(part.id) call.id+=part.id;
      if(part.function?.name) call.function.name+=part.function.name;
      if(part.function?.arguments) call.function.arguments+=part.function.arguments;
      calls.set(index,call);
    }
    if(choice.finish_reason) finish=choice.finish_reason;
  }
  if(!done || !finish) throw new GatewayError('GATEWAY_STREAM_INTERRUPTED');
  const toolCalls=[...calls.entries()].sort(([a],[b])=>a-b).map(([,call])=>call);
  if(toolCalls.some(call=>!call.id || !call.function.name)) throw new GatewayError('GATEWAY_INVALID_TOOL_CALL');
  if(finish==='length') throw new GatewayError('GATEWAY_OUTPUT_LIMIT');
  if(!['stop','tool_calls'].includes(finish)) throw new GatewayError('GATEWAY_UNEXPECTED_FINISH');
  if(finish==='tool_calls' && !toolCalls.length) throw new GatewayError('GATEWAY_MISSING_TOOL_CALL');
  return {content,toolCalls};
}
