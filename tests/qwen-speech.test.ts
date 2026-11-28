import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import WebSocket from 'ws';
import {createQwenSpeech,createQwenSpeechPool,pcmWave,type QwenSocketFactory} from '../server/qwen-speech.js';

class FakeSocket extends EventEmitter {
  readyState=WebSocket.OPEN; sent:any[]=[]; closed=false;
  constructor(private respond:(event:any,s:FakeSocket)=>void){super();queueMicrotask(()=>this.emit('open'));}
  send(raw:string){const e=JSON.parse(raw);this.sent.push(e);this.respond(e,this);}
  close(){this.closed=true;this.emit('close');}
  terminate(){this.closed=true;this.emit('close');}
  event(e:any){this.emit('message',Buffer.from(JSON.stringify(e)));}
}
const pcm=Buffer.alloc(4800,1);
function fixture(afterCommit:(s:FakeSocket)=>void){
  let socket!:FakeSocket,url='',headers:any;
  const createSocket:QwenSocketFactory=(u,opts)=>{url=u;headers=opts.headers;socket=new FakeSocket((e,s)=>{
    if(e.type==='session.update')queueMicrotask(()=>s.event({type:'session.updated'}));
    if(e.type==='input_text_buffer.commit')queueMicrotask(()=>{s.event({type:'response.created',response:{id:'r1'}});afterCommit(s);});
  });return socket as unknown as WebSocket;};
  return {createSocket,get socket(){return socket;},get url(){return url;},get headers(){return headers;}};
}
function delta(s:FakeSocket){s.event({type:'response.audio.delta',response_id:'r1',delta:pcm.toString('base64')});}
function done(s:FakeSocket){s.event({type:'response.done',response:{id:'r1',status:'completed'}});}

test('Qwen sends official Momo commit protocol with server-side auth and wraps complete PCM as WAV',async()=>{
  const f=fixture(s=>{delta(s);delta(s);done(s);});
  const audio=await createQwenSpeech({apiKey:'test-secret',speechRate:1.12},f)('你好，大肥鱼');
  assert.equal(f.url,'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime');
  assert.equal(f.headers.Authorization,'Bearer test-secret');
  const [update,append,commit,finish]=f.socket.sent;
  assert.deepEqual(update.session,{voice:'Momo',mode:'commit',language_type:'Chinese',response_format:'pcm',sample_rate:24000,speech_rate:1.12,pitch_rate:1});
  assert.equal(append.text,'你好，大肥鱼');assert.equal(commit.type,'input_text_buffer.commit');assert.equal(finish.type,'session.finish');
  assert.equal(new Set(f.socket.sent.map(e=>e.event_id)).size,4);
  assert.ok(!JSON.stringify(f.socket.sent).includes('test-secret'));
  assert.equal(audio.toString('ascii',0,4),'RIFF');assert.equal(audio.readUInt32LE(24),24000);assert.equal(audio.readUInt32LE(40),pcm.length*2);
  assert.deepEqual(audio.subarray(44),Buffer.concat([pcm,pcm]));assert.equal(f.socket.closed,true);
});
test('Qwen first-audio and stalled-audio deadlines close the socket without returning partial sound',async()=>{
  for(const [handler,code] of [[()=>{},'TTS_FIRST_AUDIO_TIMEOUT'],[(s:FakeSocket)=>delta(s),'TTS_AUDIO_STALLED']] as const){
    const f=fixture(handler);await assert.rejects(createQwenSpeech({apiKey:'test'}, {...f,firstAudioTimeoutMs:25,idleTimeoutMs:25})('你好'),new RegExp(code));assert.equal(f.socket.closed,true);
  }
});
test('Qwen abort retires its socket and a pre-aborted request never connects',async()=>{
  const f=fixture(s=>delta(s));const controller=new AbortController();
  const result=createQwenSpeech({apiKey:'test'},f)('你好',controller.signal);
  await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(result,/TTS_CANCELLED/);assert.equal(f.socket.closed,true);
  const cancelled=new AbortController();cancelled.abort();
  await assert.rejects(createQwenSpeech({apiKey:'test'},{createSocket:()=>{throw new Error('must not connect');}})('你好',cancelled.signal),/TTS_CANCELLED/);
});
test('Qwen rejects provider errors, invalid audio, mismatched responses and incomplete output',async()=>{
  for(const handler of [
    (s:FakeSocket)=>s.event({type:'error',error:{message:'sensitive upstream detail'}}),
    (s:FakeSocket)=>{delta(s);s.event({type:'response.done',response:{id:'r1',status:'failed'}});},
    (s:FakeSocket)=>{delta(s);s.event({type:'response.done',response:{id:'another',status:'completed'}});},
    (s:FakeSocket)=>s.event({type:'response.audio.delta',response_id:'r1',delta:'%%%'}),
    (s:FakeSocket)=>done(s),
    (s:FakeSocket)=>s.close(),
  ]){
    const f=fixture(handler);await assert.rejects(createQwenSpeech({apiKey:'test'},f)('你好'),error=>String(error).startsWith('Error: TTS_')&&!String(error).includes('sensitive'));assert.equal(f.socket.closed,true);
  }
  assert.throws(()=>pcmWave(Buffer.from([1])),/INVALID/);
});

test('Qwen exposes valid PCM before response.done for streaming consumers',async()=>{
  let finish!:()=>void;const chunks:Buffer[]=[];
  const f=fixture(s=>{delta(s);finish=()=>done(s);});
  let settled=false;const result=createQwenSpeech({apiKey:'test'},f)('你好',undefined,chunk=>chunks.push(chunk)).finally(()=>{settled=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);assert.deepEqual(chunks,[pcm]);finish();assert.equal((await result).length,pcm.length+44);
});

test('authenticated speech context keeps one configured socket and serializes prefetched clauses',async()=>{
  let connects=0;
  const f=fixture(s=>delta(s));
  const pool=createQwenSpeechPool({apiKey:'test'},{...f,createSocket:(u,o)=>{connects++;return f.createSocket(u,o);}});
  try {
    const first=pool('第一句。',undefined,undefined,'credential:call');
    await new Promise(resolve=>setImmediate(resolve));
    const id=pool.sessionId('credential:call');assert.ok(id);
    const second=pool('第二句。',undefined,undefined,'credential:call');
    assert.equal(connects,1);assert.equal(f.socket.sent.filter(e=>e.type==='input_text_buffer.commit').length,1);
    done(f.socket);await first;await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.socket.sent.filter(e=>e.type==='session.update').length,1);
    assert.equal(f.socket.sent.filter(e=>e.type==='input_text_buffer.commit').length,2);
    assert.equal(pool.sessionId('credential:call'),id);done(f.socket);await second;
    assert.equal(f.socket.closed,false);assert.equal(f.socket.sent.some(e=>e.type==='session.finish'),false);
  } finally {pool.close();}
  assert.equal(f.socket.closed,true);
});

test('barge in abort closes shared synthesis and rejects queued audio before a fresh session',async()=>{
  const f=fixture(s=>delta(s)),pool=createQwenSpeechPool({apiKey:'test'},f),cancel=new AbortController();
  const first=pool('旧回复',cancel.signal,undefined,'credential:call');
  const rejection1=assert.rejects(first,/TTS_CANCELLED/);
  await new Promise(resolve=>setImmediate(resolve));
  const oldId=pool.sessionId('credential:call');
  const second=pool('旧预取',undefined,undefined,'credential:call');const rejection2=assert.rejects(second,/TTS_CANCELLED/);
  cancel.abort();await Promise.all([rejection1,rejection2]);assert.equal(f.socket.closed,true);assert.equal(pool.sessionId('credential:call'),undefined);
  const fresh=pool('新回复',undefined,undefined,'credential:call');await new Promise(resolve=>setImmediate(resolve));
  assert.notEqual(pool.sessionId('credential:call'),oldId);done(f.socket);await fresh;pool.close();
});

test('speech context is isolated by credential and idle sockets expire',async()=>{
  const sockets:FakeSocket[]=[];
  const pool=createQwenSpeechPool({apiKey:'test'},{keepAliveMs:15,createSocket:(u,o)=>{
    const f=fixture(s=>{delta(s);done(s);}),socket=f.createSocket(u,o);sockets.push(socket as unknown as FakeSocket);return socket;
  }});
  try {
    await Promise.all([pool('甲',undefined,undefined,'credentialA:call'),pool('乙',undefined,undefined,'credentialB:call')]);
    assert.equal(sockets.length,2);assert.notEqual(pool.sessionId('credentialA:call'),pool.sessionId('credentialB:call'));
    await new Promise(resolve=>setTimeout(resolve,30));assert.ok(sockets.every(s=>s.closed));
    assert.equal(pool.sessionId('credentialA:call'),undefined);
  } finally {pool.close();}
});

test('a stalled reusable synthesis retires active and queued work without replaying incomplete PCM',async()=>{
  const f=fixture(s=>delta(s)),pool=createQwenSpeechPool({apiKey:'test'},{...f,idleTimeoutMs:20});
  const first=pool('第一句',undefined,undefined,'credential:call');const rejected=assert.rejects(first,/TTS_AUDIO_STALLED/);
  await new Promise(resolve=>setImmediate(resolve));
  const next=pool('后续句子',undefined,undefined,'credential:call');const rejectedNext=assert.rejects(next,/TTS_AUDIO_STALLED/);
  await Promise.all([rejected,rejectedNext]);assert.equal(f.socket.closed,true);assert.equal(pool.sessionId('credential:call'),undefined);pool.close();
});
