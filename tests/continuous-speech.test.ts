import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { registerContinuousSpeech } from '../server/continuous-speech.js';
import { sanitizeSpeech } from '../server/speech.js';
import { ApiError } from '../server/db.js';
import type { LiveSpeechEvents } from '../server/qwen-live.js';

async function fixture() {
  const app = Fastify(); const texts: string[] = []; let events!: LiveSpeechEvents, cancels = 0, pauses = 0;
  app.addHook('onRequest', async req => { req.edgeIdentity = { id: String(req.headers.authorization), device_id: 'device', agent_id: 'agent' }; });
  app.setErrorHandler((e, req, reply) => reply.code(e instanceof ApiError ? e.status : 500).send({ error: 'unavailable' }));
  registerContinuousSpeech(app, {} as any, sanitizeSpeech, e => { events = e; return {
    append: text => { texts.push(text); }, finish: () => {}, cancel: () => { cancels++; }, pause: () => { pauses++; }, resume: () => {},
  }; });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as { port: number }, base = `http://127.0.0.1:${address.port}/model/v1/speech/live`;
  return { app, base, texts, get events() { return events; }, get cancels() { return cancels; }, get pauses() { return pauses; } };
}
const headers = { authorization: 'owner-A', 'Content-Type': 'application/json' };
test('one authenticated audio stream accepts later text, rejects another credential, and ends explicitly', async () => {
  const f = await fixture(), id = randomUUID();
  try {
    const response = await fetch(f.base, { method: 'POST', headers, body: JSON.stringify({ id, text: '你好呀。', source: 'call' }) });
    assert.equal(response.status, 200);
    const denied = await fetch(`${f.base}/${id}`, { method: 'PATCH', headers: { ...headers, authorization: 'owner-B' }, body: JSON.stringify({ text: '不得注入' }) }); assert.equal(denied.status, 404);
    const append = await fetch(`${f.base}/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ text: '**我在听呢。**', finish: true }) }); assert.equal(append.status, 200);
    const late = await fetch(`${f.base}/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ text: '迟到的文本' }) }); assert.equal(late.status, 409);
    f.events.pcm(Buffer.alloc(4800)); f.events.done();
    const lines = (await response.text()).trim().split('\n').map(s => JSON.parse(s));
    assert.deepEqual(f.texts, ['你好呀。', '我在听呢。']); assert.equal(lines[0].session_id, id); assert.equal(lines.at(-1).frames, 2400);
    assert.deepEqual(lines.map(e => e.type), ['start', 'text', 'audio', 'done']);
  } finally { await f.app.close(); }
});
test('disconnect retires input and audio, and producer pauses on response backpressure', async () => {
  const f = await fixture(), id = randomUUID(), cancel = new AbortController();
  try {
    const response = await fetch(f.base, { method: 'POST', headers, signal: cancel.signal, body: JSON.stringify({ id, text: '我在这里。', source: 'chat' }) });
    f.events.pcm(Buffer.alloc(128 * 1024)); assert.ok(f.pauses > 0);
    cancel.abort(); await response.body?.cancel().catch(() => {});
    const until = Date.now() + 1000; while (!f.cancels && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(f.cancels, 1);
    const late = await fetch(`${f.base}/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ text: '不能继续' }) }); assert.equal(late.status, 404);
  } finally { await f.app.close(); }
});
