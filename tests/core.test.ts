import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical,hash } from '../server/db.js';
import { explicitMemoryIntent,toolsFor } from '../server/tools.js';
import { sseData } from '../server/gateway.js';

test('body hashing is stable across object key order, but preserves operation changes',()=>{
  assert.equal(hash(canonical({b:2,a:{z:3,y:4}})),hash(canonical({a:{y:4,z:3},b:2})));
  assert.notEqual(hash(canonical({content:'旧事实'})),hash(canonical({content:'新事实'})));
});
test('memory tools require explicit intent and respect negative instructions',()=>{
  assert.equal(explicitMemoryIntent('记住，我偏好中文。'),true);
  assert.equal(explicitMemoryIntent('不要记住这段话。'),false);
  assert.equal(explicitMemoryIntent('你好，今天怎么样？'),false);
  assert.equal(toolsFor(false).some(t=>t.function.name==='anylink_memory_save'),false);
  assert.equal(toolsFor(true).some(t=>t.function.name==='anylink_memory_update'),true);
});
test('SSE decoding handles UTF-8 split across chunks, CRLF and multiline events',async()=>{
  const bytes=new TextEncoder().encode('data: 中文\r\ndata: 第二行\r\n\r\n: ping\n\ndata: [DONE]\n\n');
  const stream=new ReadableStream<Uint8Array>({start(c){for(let i=0;i<bytes.length;i+=2)c.enqueue(bytes.slice(i,i+2));c.close();}});
  const values=[];for await(const value of sseData(stream))values.push(value);
  assert.deepEqual(values,['中文\n第二行','[DONE]']);
});
