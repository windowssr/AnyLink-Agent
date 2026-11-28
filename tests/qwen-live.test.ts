import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { openQwenLive } from '../server/qwen-live.js';

class Socket extends EventEmitter {
  sent: any[] = []; readyState = WebSocket.OPEN; closed = false;
  constructor(private reply: (event: any, socket: Socket) => void) { super(); queueMicrotask(() => this.emit('open')); }
  send(raw: string) { const event = JSON.parse(raw); this.sent.push(event); this.reply(event, this); }
  terminate() { this.closed = true; this.emit('close'); }
  pause() {} resume() {}
  event(event: any) { this.emit('message', Buffer.from(JSON.stringify(event))); }
}
test('continuous Qwen uses server commit and carries multiple text appends in one audio response', async () => {
  let socket!: Socket; const chunks: Buffer[] = []; let finished!: () => void;
  const done = new Promise<void>(resolve => { finished = resolve; });
  const live = openQwenLive({ apiKey: 'test' }, { pcm: audio => chunks.push(audio), done: finished, error: code => assert.fail(code) }, { createSocket: () => {
    socket = new Socket((e, s) => {
      if (e.type === 'session.update') queueMicrotask(() => s.event({ type: 'session.updated', session: { voice: 'Momo' } }));
      if (e.type === 'input_text_buffer.append') {
        s.event({ type: 'response.created', response: { id: 'one-response' } });
        s.event({ type: 'response.audio.delta', response_id: 'one-response', delta: Buffer.alloc(4800).toString('base64') });
      }
      if (e.type === 'session.finish') { s.event({ type: 'response.done', response: { id: 'one-response', status: 'completed' } }); s.event({ type: 'session.finished' }); }
    }); return socket as unknown as WebSocket;
  } });
  live.append('你好呀。'); live.append('今天过得怎么样？'); live.finish(); await done;
  assert.equal(socket.sent[0].session.mode, 'server_commit'); assert.equal(socket.sent.some(e => e.type === 'input_text_buffer.commit'), false);
  assert.equal(socket.sent.find(e => e.type === 'input_text_buffer.append').text, '你好呀。今天过得怎么样？');
  assert.equal(chunks.length, 1); assert.equal(socket.closed, true);
});
test('continuous synthesis cancellation retires the socket and suppresses late audio', async () => {
  let socket!: Socket, count = 0;
  const live = openQwenLive({ apiKey: 'test' }, { pcm: () => { count++; }, done: () => assert.fail(), error: () => assert.fail() }, { createSocket: () => {
    socket = new Socket(() => {}); return socket as unknown as WebSocket;
  } });
  live.append('尚未播放'); live.cancel();
  socket.event({ type: 'response.created', response: { id: 'late' } }); socket.event({ type: 'response.audio.delta', response_id: 'late', delta: Buffer.alloc(200).toString('base64') });
  assert.equal(count, 0); assert.equal(socket.closed, true);
});
test('continuous synthesis has a deadline even when the provider never returns audio', async () => {
  let socket!: Socket, fail!: (code: string) => void;
  const failure = new Promise<string>(resolve => { fail = resolve; });
  const live = openQwenLive({ apiKey: 'test' }, { pcm: () => {}, done: () => assert.fail(), error: fail }, { timeoutMs: 20, createSocket: () => {
    socket = new Socket(() => {}); return socket as unknown as WebSocket;
  } });
  live.append('你好'); assert.match(await failure, /^TTS_.*TIMEOUT$/); assert.equal(socket.closed, true);
});
