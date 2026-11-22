import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {openSync,closeSync,chmodSync} from 'node:fs';
/** A local receipt journal is mandatory. Retained started rows are never rerun. */
export class AnyLinkWorker {
  #client;#handlers;#db;#binding;
  constructor({client,handlers,journalPath}){
    if(!journalPath||journalPath===':memory:')throw new TypeError('Use a persistent private journalPath');
    closeSync(openSync(journalPath,'a',0o600));chmodSync(journalPath,0o600);
    this.#client=client;this.#handlers=handlers;this.#db=new DatabaseSync(journalPath);
    this.#db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS executions(task_id TEXT PRIMARY KEY,state TEXT NOT NULL,result TEXT); CREATE TABLE IF NOT EXISTS worker_binding(singleton INTEGER PRIMARY KEY CHECK(singleton=1),server TEXT NOT NULL,device_id TEXT NOT NULL,agent_id TEXT);');
    if(!this.#db.prepare('PRAGMA table_info(worker_binding)').all().some(c=>c.name==='agent_id'))this.#db.exec('ALTER TABLE worker_binding ADD COLUMN agent_id TEXT');
  }
  async #bound(){
    this.#binding??=(async()=>{
      const {device,agent}=await this.#client.identity(),agentId=agent?.id??null;
      this.#db.prepare('INSERT OR IGNORE INTO worker_binding(singleton,server,device_id,agent_id) VALUES(1,?,?,?)').run(this.#client.baseUrl,device.id,agentId);
      const owner=this.#db.prepare('SELECT server,device_id,agent_id FROM worker_binding WHERE singleton=1').get();
      if(owner.server!==this.#client.baseUrl||owner.device_id!==device.id||(owner.agent_id!==null&&agentId!==null&&owner.agent_id!==agentId))throw new Error('Journal belongs to another service or device; use its original identity or a separate journal');
      if(owner.agent_id===null&&agentId!==null)this.#db.prepare('UPDATE worker_binding SET agent_id=? WHERE singleton=1').run(agentId);
    })();
    const binding=this.#binding;
    try{await binding;}catch(error){
      // An unavailable tunnel during startup must not poison future identity
      // checks. Only this read/bind attempt is reset; execution rows stay intact.
      if(this.#binding===binding)this.#binding=undefined;
      throw error;
    }
  }
  async advertise(options){await this.#bound();return this.#client.registerCapabilities(Object.entries(this.#handlers).map(([name,h])=>({name,description:h.description})),options);}
  async runNext({signal}={}){
    await this.#bound();
    const {task}=await this.#client.claimTask({signal});if(!task)return null;
    const current=await this.#client.task(task.id,{signal});
    if(current.state!=='running')return {task:current,replayed:true,execution_unknown:current.state==='unknown'};
    if(!this.#db.prepare("INSERT OR IGNORE INTO executions(task_id,state) VALUES(?,'started')").run(task.id).changes)return {task,replayed:true,execution_unknown:true};
    const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);
    if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
    let watching=true,watch;
    const resultKey=`result:${task.id}`;
    try{
      watch=(async()=>{while(watching&&!controller.signal.aborted){try{await delay(1000,undefined,{signal:controller.signal});if(watching&&(await this.#client.task(task.id,{signal:controller.signal})).state==='cancel_requested')controller.abort(new Error('Task cancelled'));}catch{if(watching)controller.abort(new Error('Task authority could not be checked'));}}})();
      const handler=this.#handlers[task.capability];let result;
      if(!handler)result={state:'failed',error:{code:'CAPABILITY_UNAVAILABLE',message:'No local handler is registered'}};
      else{
        // Claim admission is current on the server. Local host policy remains
        // authoritative for individual side effects inside each handler.
        try{controller.signal.throwIfAborted();result={state:'succeeded',output:await handler.execute(task.input,{task,signal:controller.signal})};}
        catch(error){result={state:'unknown',error:{code:controller.signal.aborted?'INTERRUPTED_OUTCOME_UNKNOWN':'HANDLER_OUTCOME_UNKNOWN',message:'The host handler did not return a durable result; inspect its effects before retrying'}};}
      }
      this.#db.prepare("UPDATE executions SET state='finished',result=? WHERE task_id=?").run(JSON.stringify(result),task.id);
      const completed=await this.#client.completeTask(task.id,result,{idempotencyKey:resultKey});
      this.#db.prepare("UPDATE executions SET state='reported' WHERE task_id=?").run(task.id);
      return {task:completed,replayed:false,execution_unknown:result.state==='unknown'};
    }finally{watching=false;controller.abort();await watch;signal?.removeEventListener('abort',abort);}
  }
  /** Re-send a durable result, never re-run a handler. Started rows need human reconciliation. */
  async recoverResults(){
    await this.#bound();
    const results=[];
    for(const row of this.#db.prepare("SELECT task_id,result FROM executions WHERE state='finished'").all()){
      results.push(await this.#client.completeTask(row.task_id,JSON.parse(row.result),{idempotencyKey:`result:${row.task_id}`}));
      this.#db.prepare("UPDATE executions SET state='reported' WHERE task_id=?").run(row.task_id);
    }
    return results;
  }
  async run({signal,pollIntervalMs=2000}={}){
    await this.advertise({signal});
    while(!signal?.aborted){await this.runNext({signal});try{await delay(pollIntervalMs,undefined,{signal});}catch(error){if(!signal?.aborted)throw error;}}
  }
  close(){this.#db.close();}
}
