import {AssistantMessageEventStream, getCurrentTools} from '../runtime/pi-agent.js';
import {AgentFailure, MODEL, SSEParser, publicFailure, wireMessages} from './protocol.mjs';

export const model = {id: MODEL, name: 'DeepSeek Flash', api: 'openai-completions', provider: 'anylink', baseUrl: '', reasoning: false, input: ['text'], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 128000, maxTokens: 2048};
const usage = () => ({input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}});

export function streamFromProxy(request, run, persist, onFailure) {
  return (_model, context, options = {}) => {
    const stream = new AssistantMessageEventStream();
    const message = {role: 'assistant', content: [], api: model.api, provider: model.provider, model: MODEL, usage: usage(), stopReason: 'stop', timestamp: Date.now()};
    (async () => {
      try {
        if (run.model_calls >= 6) throw new AgentFailure('TURN_LIMIT', '这轮已经执行多步，先停在这里。请查看执行结果后继续。');
        run.model_calls++; persist();
        let done = false, finishReason, textIndex = -1; const calls = new Map();
        stream.push({type: 'start', partial: message});
        const parser = new SSEParser(data => {
          if (done) return;
          if (data === '[DONE]') { done = true; return; }
          const payload = JSON.parse(data);
          if (payload.error) throw new AgentFailure('MODEL_STREAM_ERROR', '模型流未完成，没有自动重发', true);
          if (payload.usage) Object.assign(message.usage, {input: payload.usage.prompt_tokens ?? 0, output: payload.usage.completion_tokens ?? 0, totalTokens: payload.usage.total_tokens ?? 0});
          const choice = payload.choices?.[0]; if (!choice) return;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta ?? {};
          if (typeof delta.content === 'string' && delta.content) {
            if (textIndex < 0) { textIndex = message.content.length; message.content.push({type: 'text', text: ''}); stream.push({type: 'text_start', contentIndex: textIndex, partial: message}); }
            message.content[textIndex].text += delta.content;
            stream.push({type: 'text_delta', contentIndex: textIndex, delta: delta.content, partial: message});
          }
          for (const part of delta.tool_calls ?? []) {
            if (!Number.isInteger(part.index) || part.index < 0 || part.index > 15) throw new AgentFailure('BAD_TOOL_CALL', '模型工具调用格式不正确', true);
            let call = calls.get(part.index);
            if (!call) { call = {id: '', name: '', raw: ''}; calls.set(part.index, call); }
            call.id += part.id ?? ''; call.name += part.function?.name ?? ''; call.raw += part.function?.arguments ?? '';
            if (call.raw.length > 32000) throw new AgentFailure('BAD_TOOL_CALL', '工具参数超过本机限制', true);
          }
        });
        const tools = getCurrentTools(context.messages);
        await request('/model/v1/chat/completions', {method: 'POST', signal: options.signal, body: {model: MODEL, messages: wireMessages(context), stream: true, max_tokens: 2048, ...(tools.length ? {tools: tools.map(t => ({type: 'function', function: {name: t.name, description: t.description, parameters: t.parameters}}))} : {})}, onText: chunk => parser.feed(chunk)});
        if (!done || !finishReason) throw new AgentFailure('MODEL_RESULT_UNKNOWN', '模型响应没有完整结束，没有自动重发', true);
        if (textIndex >= 0) stream.push({type: 'text_end', contentIndex: textIndex, content: message.content[textIndex].text, partial: message});
        if (calls.size && finishReason !== 'tool_calls') throw new AgentFailure('TRUNCATED_TOOL_CALL', '工具调用未完整结束，未执行工具', true);
        const seen = new Set();
        for (const [, call] of [...calls].sort((a, b) => a[0] - b[0])) {
          if (!call.id || seen.has(call.id) || !/^[a-zA-Z0-9_-]+$/.test(call.name)) throw new AgentFailure('BAD_TOOL_CALL', '工具调用标识不正确，未执行工具', true);
          seen.add(call.id); const args = JSON.parse(call.raw);
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new AgentFailure('BAD_TOOL_CALL', '工具参数不正确，未执行工具', true);
          const contentIndex = message.content.length, toolCall = {type: 'toolCall', id: call.id, name: call.name, arguments: args};
          message.content.push(toolCall); stream.push({type: 'toolcall_start', contentIndex, partial: message}); stream.push({type: 'toolcall_end', contentIndex, toolCall, partial: message});
        }
        message.stopReason = calls.size ? 'toolUse' : finishReason === 'length' ? 'length' : 'stop';
        stream.push({type: 'done', reason: message.stopReason, message}); stream.end();
      } catch (error) {
        if (!(error instanceof AgentFailure)) error = new AgentFailure('MODEL_PROTOCOL_UNKNOWN', '模型响应格式未确认，没有自动重发', true);
        onFailure(error); message.stopReason = options.signal?.aborted ? 'aborted' : 'error'; message.errorMessage = publicFailure(error);
        stream.push({type: 'error', reason: message.stopReason, error: message}); stream.end();
      }
    })();
    return stream;
  };
}
