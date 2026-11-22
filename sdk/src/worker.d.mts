import type {AnyLinkClient,Payload,Task,RequestOptions} from './client.mjs';
export class TaskFailure extends Error {constructor(code:string,message:string);code:string;taskFailure:true}
export interface HostHandler {description:string;execute(input:Payload,context:{task:Task;signal:AbortSignal}):Promise<Payload>}
export class AnyLinkWorker {
 constructor(options:{client:AnyLinkClient;handlers:Record<string,HostHandler>;journalPath:string});
 advertise(options?:RequestOptions):Promise<unknown>;
 runNext(options?:{signal?:AbortSignal}):Promise<{task:Task;replayed:boolean;execution_unknown:boolean}|null>;
 recoverResults():Promise<Task[]>;
 run(options?:{signal?:AbortSignal;pollIntervalMs?:number}):Promise<void>;
 close():void;
}
