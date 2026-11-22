export class AnyLinkError extends Error {
  constructor(message, {code='ANYLINK_ERROR',status=0,requestId,idempotencyKey,submissionUnknown=false,cause}={}) {
    super(message,{cause});this.name='AnyLinkError';Object.assign(this,{code,status,requestId,idempotencyKey,submissionUnknown});
  }
}
function checkBaseUrl(baseUrl){
  const base=new URL(baseUrl);
  if(base.username||base.password||base.search||base.hash||!['http:','https:'].includes(base.protocol))throw new TypeError('Use an HTTP(S) base URL without credentials, query or fragment');
  if(base.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(base.hostname))throw new TypeError('Remote AnyLink connections require HTTPS or a loopback tunnel');
  return base.href.replace(/\/$/,'')+'/';
}
/** No background retries: callers retain write keys and reconcile uncertain outcomes. */
export class AnyLinkClient {
  #base;#token;#fetch;#timeout;
  get baseUrl(){return this.#base;}
  constructor({baseUrl,token,fetch:transport=globalThis.fetch,timeoutMs=30000}) {
    if(typeof token!=='string'||!token.trim()||/[\r\n]/.test(token))throw new TypeError('A device credential is required');
    if(!Number.isFinite(timeoutMs)||timeoutMs<1)throw new TypeError('timeoutMs must be positive');
    this.#base=checkBaseUrl(baseUrl);this.#token=token;this.#fetch=transport;this.#timeout=timeoutMs;
  }
  /** Join with the owner key: upserts the install's device and agent, returns a fresh credential. Reconnect rotates the token safely. */
  static async connect({baseUrl,joinKey,installId,device,agent,fetch:transport=globalThis.fetch,timeoutMs=30000}){
    const base=checkBaseUrl(baseUrl);
    if(typeof joinKey!=='string'||!joinKey.trim()||/[\r\n]/.test(joinKey))throw new TypeError('A join key is required');
    if(!Number.isFinite(timeoutMs)||timeoutMs<1)throw new TypeError('timeoutMs must be positive');
    let response;
    try{
      response=await transport(new URL('edge/v1/connect',base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),headers:{Authorization:`Bearer ${joinKey}`,'Content-Type':'application/json'},body:JSON.stringify({device:{install_id:installId,name:device?.name,platform:device?.platform},agent:{key:agent?.key,name:agent?.name,...(agent?.kind!==undefined?{kind:agent.kind}:{})}})});
    }catch(cause){throw new AnyLinkError('AnyLink connect failed',{code:'TRANSPORT_ERROR',cause});}
    const requestId=response.headers.get('x-anylink-request-id')??undefined;
    if(!response.ok){
      let data;try{data=await response.json();}catch{}
      throw new AnyLinkError(data?.error?.message??`AnyLink HTTP ${response.status}`,{code:data?.error?.code??'HTTP_ERROR',status:response.status,requestId:data?.request_id??requestId});
    }
    try{return await response.json();}catch(cause){throw new AnyLinkError('AnyLink response was incomplete',{code:'INVALID_RESPONSE',requestId,cause});}
  }
  async #request(method,path,body,{idempotencyKey,signal,raw=false,headers={}}={}) {
    const writing=!['GET','HEAD'].includes(method),key=writing&&idempotencyKey!==false?(idempotencyKey??crypto.randomUUID()):undefined;
    const requestSignal=AbortSignal.any([AbortSignal.timeout(this.#timeout),...(signal?[signal]:[])]);
    let response;
    try {
      response=await this.#fetch(new URL(path,this.#base),{method,redirect:'error',signal:requestSignal,headers:{Authorization:`Bearer ${this.#token}`,...(body!==undefined?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    } catch(cause) {
      throw new AnyLinkError(writing?'Submission outcome is unknown; do not repeat execution blindly':'AnyLink request failed',{code:writing?'SUBMISSION_UNKNOWN':'TRANSPORT_ERROR',idempotencyKey:key,submissionUnknown:writing,cause});
    }
    const requestId=response.headers.get('x-anylink-request-id')??undefined;
    if(!response.ok){
      let data;try{data=await response.json();}catch{}
      throw new AnyLinkError(data?.error?.message??`AnyLink HTTP ${response.status}`,{code:data?.error?.code??'HTTP_ERROR',status:response.status,requestId:data?.request_id??requestId,idempotencyKey:key,submissionUnknown:writing&&response.status>=500&&data?.error?.code!=='PROVIDER_NOT_CONFIGURED'});
    }
    if(raw)return response;
    try{return await response.json();}catch(cause){throw new AnyLinkError('AnyLink response was incomplete',{code:writing?'SUBMISSION_UNKNOWN':'INVALID_RESPONSE',requestId,idempotencyKey:key,submissionUnknown:writing,cause});}
  }
  protocol(options){return this.#request('GET','edge/v1/link/protocol',undefined,options);}
  /** @deprecated Compatibility shim returning per-device capability unions; use directory() for agent routing. */
  peers(options){return this.#request('GET','edge/v1/link/peers',undefined,options);}
  directory(options){return this.#request('GET','edge/v1/link/directory',undefined,options);}
  persona(options){return this.#request('GET','edge/v1/persona',undefined,options);}
  /** Adopt an install_id for this credential's device so join-key connect lands on the same device. Naturally idempotent; no Idempotency-Key. */
  adoptInstallId(installId,options={}){return this.#request('POST','edge/v1/device/install-id',{install_id:installId},{idempotencyKey:false,...options});}
  identity(options){return this.#request('GET','edge/v1/identity',undefined,options);}
  context(options){return this.#request('GET','edge/v1/context',undefined,options);}
  searchMemories(query={},options){return this.#request('POST','edge/v1/memories/search',query,{...options,idempotencyKey:false});}
  saveMemory(memory,options){return this.#request('POST','edge/v1/memories',memory,options);}
  updateMemory(id,revision,patch,options){return this.#request('PATCH',`edge/v1/memories/${encodeURIComponent(id)}`,{...patch,expected_revision:revision},options);}
  deleteMemory(id,revision,options){return this.#request('DELETE',`edge/v1/memories/${encodeURIComponent(id)}`,undefined,{...options,headers:{'If-Match':String(revision)}});}
  chatCompletions(input,options){return this.#request('POST','model/v1/chat/completions',{...input,stream:false},{...options,idempotencyKey:false});}
  async *streamChatCompletions(input,options){
    const response=await this.#request('POST','model/v1/chat/completions',{...input,stream:true},{...options,idempotencyKey:false,raw:true});
    if(!response.headers.get('content-type')?.includes('text/event-stream')){await response.body?.cancel();throw new AnyLinkError('Expected an SSE model response',{code:'INVALID_STREAM',submissionUnknown:true});}
    const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',done=false;
    try{
      while(!done){
        const chunk=await reader.read();pending+=decoder.decode(chunk.value,{stream:!chunk.done});
        pending=pending.replaceAll('\r\n','\n');
        if(pending.length>2*1024*1024)throw new AnyLinkError('SSE event exceeded 2 MiB',{code:'INVALID_STREAM',submissionUnknown:true});
        let boundary;
        while((boundary=pending.indexOf('\n\n'))>=0){
          const event=pending.slice(0,boundary);pending=pending.slice(boundary+2);
          const data=event.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).replace(/^ /,'')).join('\n');
          if(data==='[DONE]'){done=true;break;}
          if(data){let parsed;try{parsed=JSON.parse(data);}catch(cause){throw new AnyLinkError('Invalid model SSE data',{code:'INVALID_STREAM',submissionUnknown:true,cause});}yield parsed;}
        }
        if(chunk.done&&!done)throw new AnyLinkError('Model stream ended without [DONE]; it will not be retried',{code:'STREAM_INCOMPLETE',submissionUnknown:true});
      }
    }catch(cause){if(cause instanceof AnyLinkError)throw cause;throw new AnyLinkError('Model stream was interrupted',{code:'STREAM_INCOMPLETE',submissionUnknown:true,cause});}
    finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  registerCapabilities(capabilities,options){return this.#request('POST','edge/v1/link/capabilities',{capabilities},options);}
  createTask(task,options){return this.#request('POST','edge/v1/link/tasks',task,options);}
  task(id,options){return this.#request('GET',`edge/v1/link/tasks/${encodeURIComponent(id)}`,undefined,options);}
  listTasks(query={},options){return this.#request('GET','edge/v1/link/tasks?'+new URLSearchParams(query),undefined,options);}
  claimTask(options){return this.#request('POST','edge/v1/link/tasks/claim',{},options);}
  completeTask(id,result,options){return this.#request('POST',`edge/v1/link/tasks/${encodeURIComponent(id)}/result`,result,options);}
  cancelTask(id,options){return this.#request('POST',`edge/v1/link/tasks/${encodeURIComponent(id)}/cancel`,{},options);}
}
