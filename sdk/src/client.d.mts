export type JsonValue = null | boolean | number | string | JsonValue[] | {[key:string]:JsonValue};
export type Payload = {[key:string]:JsonValue};
export interface RequestOptions {idempotencyKey?:string;signal?:AbortSignal}
export interface Capability {name:string;description:string}
export type TaskState='queued'|'running'|'cancel_requested'|'succeeded'|'failed'|'cancelled'|'unknown'|'expired';
export interface TaskResult {state:'succeeded'|'failed'|'cancelled'|'unknown';output?:Payload;error?:{code:string;message:string}}
export interface Task {id:string;source_device_id:string;source_agent_id:string;target_agent_id:string|null;claimed_by_agent_id:string|null;target_device_id:string|null;capability:string;input:Payload;state:TaskState;result:TaskResult|null;created_at:string;expires_at:string;started_at:string|null;finished_at:string|null}
export type MemoryScope='global'|'device'|'agent';
export interface Memory {id:string;title:string;content:string;scope:MemoryScope;applicable_device_id:string|null;applicable_agent_id:string|null;source_device_id:string|null;source_agent_id:string|null;revision:number;deleted:boolean}
export interface MemoryInput {title:string;content:string;scope:MemoryScope;applicable_device_id?:string|null;applicable_agent_id?:string|null}
export interface Agent {id:string;key:string;name:string;kind:string;capabilities:Capability[]}
export interface DirectoryAgent extends Agent {last_seen_at:string|null;online:boolean;self:boolean}
export interface DirectoryDevice {id:string;name:string;platform:string}
export interface ConnectResponse {device_id:string;agent_id:string;credential_id:string;token:string;protocol:{name:string;version:string}}
export interface Persona {name:string;sha256:string;content:string}
export class AnyLinkError extends Error {constructor(message:string,options?:{code?:string;status?:number;requestId?:string;idempotencyKey?:string;submissionUnknown?:boolean;cause?:unknown});code:string;status:number;requestId?:string;idempotencyKey?:string;submissionUnknown:boolean}
export class AnyLinkClient {
 readonly baseUrl:string;
 constructor(options:{baseUrl:string;token:string;fetch?:typeof fetch;timeoutMs?:number});
 static connect(options:{baseUrl:string;joinKey:string;installId:string;device:{name:string;platform:'macos'|'android'|'other'};agent:{key:string;name:string;kind?:string};fetch?:typeof fetch;timeoutMs?:number}):Promise<ConnectResponse>;
 protocol(options?:RequestOptions):Promise<{protocol:'anylink';version:string;delivery:string;requeue:false;capabilities:string[];routing:string[]}>;
 /** @deprecated Use directory(); peers() returns per-device unions for legacy clients. */
 peers(options?:RequestOptions):Promise<{items:{id:string;name:string;platform:string;capabilities:Capability[];last_seen_at:string|null}[]}>;
 directory(options?:RequestOptions):Promise<{items:{device:DirectoryDevice;agents:DirectoryAgent[]}[]}>;
 persona(options?:RequestOptions):Promise<Persona>;
 adoptInstallId(installId:string,options?:RequestOptions):Promise<{device_id:string;install_id:string}>;
 identity(options?:RequestOptions):Promise<{device:{id:string;name:string;platform:string};agent:Agent;scopes:string[]}>;
 context(options?:RequestOptions):Promise<{device_id:string;agent_id:string;global:Memory[];device:Memory[];agent:Memory[];persona:Persona|null;directory:Payload}>;
 searchMemories(query?:{q?:string;scope?:MemoryScope;device_id?:string},options?:RequestOptions):Promise<{items:Memory[]}>;
 saveMemory(memory:MemoryInput,options?:RequestOptions):Promise<Memory>;
 updateMemory(id:string,revision:number,patch:{title?:string;content?:string},options?:RequestOptions):Promise<Memory>;
 deleteMemory(id:string,revision:number,options?:RequestOptions):Promise<unknown>;
 chatCompletions(input:Payload,options?:RequestOptions):Promise<Payload>;
 speech(input:{text:string;summarize?:boolean;voice?:'sweet-lively'|'sweet-warm'},options?:RequestOptions):Promise<{spoken_text:string;voice:string;format:string;audio_base64:string} | Payload>;
 streamChatCompletions(input:Payload,options?:RequestOptions):AsyncGenerator<Payload>;
 registerCapabilities(capabilities:Capability[],options?:RequestOptions):Promise<{agent_id:string;device_id:string;capabilities:Capability[]}>;
 createTask(task:{target?:{agent_id:string}|{device_id:string};target_device_id?:string;capability:string;input:Payload;ttl_seconds?:number},options?:RequestOptions):Promise<Task>;
 task(id:string,options?:RequestOptions):Promise<Task>;
 listTasks(query?:{role?:'source'|'target';state?:TaskState},options?:RequestOptions):Promise<{items:Task[]}>;
 claimTask(options?:RequestOptions):Promise<{task:Task|null}>;
 completeTask(id:string,result:TaskResult,options?:RequestOptions):Promise<Task>;
 cancelTask(id:string,options?:RequestOptions):Promise<Task>;
}
