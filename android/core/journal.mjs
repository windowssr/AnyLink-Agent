import {AgentFailure} from './protocol.mjs';

// Per-device authority. A submitted operation is never replayed after a crash.
export class Journal {
  constructor(storage, makeId) {
    this.storage = storage; this.makeId = makeId;
    this.value = storage.read() ?? {version: 1, session_id: makeId(), messages: [], runs: [], tools: {}};
    for (const run of this.value.runs) if (run.state === 'submitted') run.state = 'submission_unknown';
    for (const operation of Object.values(this.value.tools)) if (operation.state === 'submitted') operation.state = 'submission_unknown';
    this.save();
  }
  save() { this.storage.write(this.value); }
  begin(text) {
    const run = {id: this.makeId(), session_id: this.value.session_id, text, state: 'submitted', started_at: Date.now(), model_calls: 0};
    this.value.runs.push(run); this.value.runs = this.value.runs.slice(-80); this.save(); return run;
  }
  finish(run, state, code) { Object.assign(run, {state, finished_at: Date.now(), ...(code ? {code} : {})}); this.save(); }
  async tool(run, callId, name, args, execute) {
    const key = run.id + ':' + callId, existing = this.value.tools[key];
    if (existing) {
      if (existing.name !== name || existing.args !== JSON.stringify(args)) throw new AgentFailure('CALL_ID_CONFLICT', '工具调用编号冲突，已停止');
      if (existing.state === 'completed') return existing.result;
      throw new AgentFailure('TOOL_RESULT_UNKNOWN', '原工具结果未确认，已阻止重复执行', true);
    }
    const entry = {name, args: JSON.stringify(args), state: 'submitted', created_at: Date.now()};
    this.value.tools[key] = entry; this.save();
    try {
      const result = await execute(key);
      Object.assign(entry, {state: 'completed', result}); this.save(); return result;
    } catch (error) {
      entry.state = error.uncertain ? 'submission_unknown' : 'failed'; this.save(); throw error;
    }
  }
  newConversation() { this.value.session_id = this.makeId(); this.value.messages = []; this.save(); }
}
