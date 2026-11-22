export type JsonValue = null | boolean | number | string | JsonValue[] | {[key:string]:JsonValue};
export type Payload = {[key:string]:JsonValue};
export interface RequestOptions {idempotencyKey?:string;signal?:AbortSignal}
export interface Capability {name:string;description:string}
export type TaskState='queued'|'running'|'cancel_requested'|'succeeded'|'failed'|'cancelled'|'unknown'|'expired';
export interface TaskResult {state:'succeeded'|'failed'|'cancelled'|'unknown';output?:Payload;error?:{code:string;message:string}}
export interface Task {id:string;source_device_id:string;target_device_id:string;capability:string;input:Payload;state:TaskState;result:TaskResult|null;created_at:string;expires_at:string;started_at:string|null;finished_at:string|null}
export interface Memory {id:string;title:string;content:string;scope:'global'|'device';applicable_device_id:string|null;source_device_id:string|null;revision:number;deleted:boolean}
export interface MemoryInput {title:string;content:string;scope:'global'|'device';applicable_device_id?:string|null}
export class AnyLinkError extends Error {constructor(message:string,options?:{code?:string;status?:number;requestId?:string;idempotencyKey?:string;submissionUnknown?:boolean;cause?:unknown});code:string;status:number;requestId?:string;idempotencyKey?:string;submissionUnknown:boolean}
export class AnyLinkClient {
 readonly baseUrl:string;
 constructor(options:{baseUrl:string;token:string;fetch?:typeof fetch;timeoutMs?:number});
 protocol(options?:RequestOptions):Promise<{protocol:'anylink';version:'1.0';delivery:string;requeue:false;capabilities:string[]}>;
 identity(options?:RequestOptions):Promise<{device:{id:string;name:string;platform:string};scopes:string[]}>;
 context(options?:RequestOptions):Promise<{device_id:string;global:Memory[];device:Memory[];directory:Payload}>;
 searchMemories(query?:{q?:string;scope?:'global'|'device';device_id?:string},options?:RequestOptions):Promise<{items:Memory[]}>;
 saveMemory(memory:MemoryInput,options?:RequestOptions):Promise<Memory>;
 updateMemory(id:string,revision:number,patch:{title?:string;content?:string},options?:RequestOptions):Promise<Memory>;
 deleteMemory(id:string,revision:number,options?:RequestOptions):Promise<unknown>;
 chatCompletions(input:Payload,options?:RequestOptions):Promise<Payload>;
 streamChatCompletions(input:Payload,options?:RequestOptions):AsyncGenerator<Payload>;
 registerCapabilities(capabilities:Capability[],options?:RequestOptions):Promise<{device_id:string;capabilities:Capability[]}>;
 createTask(task:{target_device_id:string;capability:string;input:Payload;ttl_seconds?:number},options?:RequestOptions):Promise<Task>;
 task(id:string,options?:RequestOptions):Promise<Task>;
 listTasks(query?:{role?:'source'|'target';state?:TaskState},options?:RequestOptions):Promise<{items:Task[]}>;
 claimTask(options?:RequestOptions):Promise<{task:Task|null}>;
 completeTask(id:string,result:TaskResult,options?:RequestOptions):Promise<Task>;
 cancelTask(id:string,options?:RequestOptions):Promise<Task>;
}
