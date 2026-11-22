import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AnyLinkClient,AnyLinkError} from '../src/client.mjs';
test('unknown writes expose their stable key and never retry',async()=>{
  let calls=0;const client=new AnyLinkClient({baseUrl:'https://example.test',token:'fixture',fetch:async()=>{calls++;throw new Error('Disconnected');}});
  await assert.rejects(client.createTask({}),e=>e instanceof AnyLinkError&&e.submissionUnknown&&!!e.idempotencyKey);assert.equal(calls,1);
});
test('split SSE preserves tool deltas and refuses incomplete streams',async()=>{
  const encoder=new TextEncoder();let wire='data: {"choices":[{"delta":{"tool_calls":[{"id":"test"}]}}]}\r\n\r\ndata: [DONE]\n\n';
  const fetch=async()=>new Response(new ReadableStream({start(c){for(let i=0;i<wire.length;i+=7)c.enqueue(encoder.encode(wire.slice(i,i+7)));c.close();}}),{headers:{'content-type':'text/event-stream'}});
  const client=new AnyLinkClient({baseUrl:'http://127.0.0.1',token:'fixture',fetch});
  const values=[];for await(const v of client.streamChatCompletions({}))values.push(v);assert.equal(values[0].choices[0].delta.tool_calls[0].id,'test');
  wire='data: {"choices":[]}\n\n';await assert.rejects(async()=>{for await(const _ of client.streamChatCompletions({})){}},e=>e.code==='STREAM_INCOMPLETE'&&e.submissionUnknown);
});
test('adoptInstallId posts the install id without an idempotency key',async()=>{
  let seen;const client=new AnyLinkClient({baseUrl:'https://example.test',token:'ak_fixture',fetch:async(url,options)=>{seen={url:String(url),options,body:JSON.parse(options.body)};return Response.json({device_id:'d',install_id:'android-x'});}});
  const result=await client.adoptInstallId('android-x');
  assert.equal(result.install_id,'android-x');assert.equal(seen.url,'https://example.test/edge/v1/device/install-id');
  assert.equal(seen.body.install_id,'android-x');assert.equal(seen.options.headers['Idempotency-Key'],undefined);
});
test('credentials are absent from errors and cannot follow redirects',async()=>{
  assert.throws(()=>new AnyLinkClient({baseUrl:'http://remote.example',token:'private-token'}),/HTTPS/);
  const client=new AnyLinkClient({baseUrl:'https://example.test',token:'private-token',fetch:async(_u,o)=>{assert.equal(o.redirect,'error');return Response.json({error:{code:'DENIED',message:'Denied'}},{status:403});}});
  await assert.rejects(client.context(),e=>e.code==='DENIED'&&!e.message.includes('private-token'));
});

test('speech posts text and returns the spoken payload without an idempotency key',async()=>{
  let seen;const client=new AnyLinkClient({baseUrl:'https://example.test',token:'ak_fixture',fetch:async(url,options)=>{seen={url:String(url),options,body:JSON.parse(options.body)};return Response.json({spoken_text:'你好呀',voice:'sweet-lively',format:'mp3',audio_base64:'QUJD'});}});
  const result=await client.speech({text:'你好',summarize:false,voice:'sweet-warm'});
  assert.equal(seen.url,'https://example.test/model/v1/speech');
  assert.equal(seen.body.text,'你好');assert.equal(seen.body.summarize,false);assert.equal(seen.body.voice,'sweet-warm');
  assert.equal(seen.options.headers['Idempotency-Key'],undefined);
  assert.equal(result.spoken_text,'你好呀');assert.equal(result.audio_base64,'QUJD');
});
