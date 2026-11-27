import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import WebSocket from 'ws';
import {createQwenSpeech,pcmWave,type QwenSocketFactory} from '../server/qwen-speech.js';

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
