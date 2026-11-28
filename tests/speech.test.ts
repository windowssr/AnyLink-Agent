import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {sanitizeSpeech,needsSummary,fallbackSpoken,registerSpeech,SUMMARIZE_SYSTEM} from '../server/speech.js';

test('sanitizeSpeech strips code, tables, markdown, urls and emoji',()=>{
  const dirty='结论：**文件已** `移动` 到桌面。\n\n```js\nconst x=1;\n```\n\n| 名称 | 大小 |\n|---|---|\n| a.txt | 1KB |\n\n- 第一项\n- 第二项\n> 引用\n# 标题\n详见 https://example.com/path 🎉\n第二行   多空格';
  const clean=sanitizeSpeech(dirty);
  for(const bad of ['const x','|','```','https://','🎉','**','`','>','- 第一项','# 标题'])assert.ok(!clean.includes(bad),`leaked: ${bad} in ${clean}`);
  assert.ok(clean.includes('文件已')&&clean.includes('桌面')&&clean.includes('详见')&&!clean.includes('移动'));
});
test('needsSummary triggers on length or rich content only',()=>{
  assert.equal(needsSummary('短。','短。'),false);
  assert.equal(needsSummary('x'.repeat(100),'x'.repeat(100)),true);
  assert.equal(needsSummary('看这里 https://a.b','看这里'),true);
  assert.equal(needsSummary('- 甲\n- 乙','甲 乙'),true);
  assert.equal(needsSummary('| a | b |\n|---|---|','a b'),true);
  assert.equal(needsSummary('```\ncode\n```','code'),true);
});
test('fallbackSpoken keeps at most two sentences within 120 chars',()=>{
  const out=fallbackSpoken('第一句。第二句！第三句？末尾。');
  assert.ok(out.length<=125);assert.ok(out.includes('第一句'));
});
async function appWith(deps:{summarize?:any;synthesize?:any;qwenSynthesize?:any}){
  const app=Fastify();
  const {ApiError}=await import('../server/db.js');const {ZodError}=await import('zod');
  app.setErrorHandler((error,req,reply)=>{
    if(error instanceof ApiError)return reply.code(error.status).send({error:{code:error.code,message:error.message}});
    if(error instanceof ZodError)return reply.code(400).send({error:{code:'INVALID_INPUT',message:'Invalid request'}});
    return reply.code(500).send({error:{code:'INTERNAL',message:'error'}});
  });
  registerSpeech(app,{deepseekApiKey:'',deepseekBaseUrl:'https://unused'} as any,null,deps);
  return app;
}

test('speech reuse keys are scoped to the reauthenticated credential and untrusted headers cannot share context',async()=>{
  const keys:(string|undefined)[]=[];
  const app=await appWith({qwenSynthesize:async(_text:string,_signal:AbortSignal,_pcm:unknown,key?:string)=>{keys.push(key);return Buffer.from('wave');}});
  app.addHook('onRequest',async req=>{const id=String(req.headers['test-credential']??'');if(id)req.edgeIdentity={id,device_id:'device',agent_id:'agent'};});
  for(const headers of [
    {'test-credential':'A','x-anylink-speech-turn':'session:call:1'},
    {'test-credential':'B','x-anylink-speech-turn':'session:call:1'},
    {'test-credential':'A','x-anylink-speech-turn':'bad turn'},
    {'x-anylink-speech-turn':'session:call:1'},
  ]){
    const result=await app.inject({method:'POST',url:'/model/v1/speech',headers,payload:{text:'你好呀',voice:'sweet-lively'}});assert.equal(result.statusCode,200);
  }
  assert.deepEqual(keys,['A:session:call:1','B:session:call:1',undefined,undefined]);await app.close();
});
test('speech route: sanitize+summarize happy path returns mp3 payload',async()=>{
  const app=await appWith({summarize:async()=>Promise.resolve('文件已经帮你整理好啦，详情在屏幕上。'),synthesize:async()=>'MP3DATA'.length?Buffer.from('ID3fake'):Buffer.alloc(0)});
  const res=await app.inject({method:'POST',url:'/model/v1/speech',payload:{text:'**完成**：已把 `报告.pdf` 移到下载目录。\n\n| 项 | 值 |\n|---|---|\n| 位置 | 下载 |\n\nhttps://x.y',summarize:true,voice:'sweet-warm'}});
  assert.equal(res.statusCode,200);
  const body=res.json();
  assert.equal(body.voice,'sweet-warm');assert.equal(body.format,'mp3');
  assert.equal(body.spoken_text,'文件已经帮你整理好啦，详情在屏幕上。');
  assert.ok(Buffer.from(body.audio_base64,'base64').length>0);
  await app.close();
});
test('speech route: summarize failure falls back to sanitized sentences',async()=>{
  const app=await appWith({summarize:async()=>{throw new Error('provider down');},synthesize:async()=>Buffer.from('audio')});
  const res=await app.inject({method:'POST',url:'/model/v1/speech',payload:{text:'整理好了，文件在下载目录。详见 https://example.com/report',summarize:true}});
  assert.equal(res.statusCode,200);
  const body=res.json();
  assert.equal(body.spoken_text,'整理好了，文件在下载目录。详见');
  await app.close();
});
test('speech route: synthesis failure returns 502 with spoken_text',async()=>{
  const app=await appWith({summarize:async()=>'改写后的口播。',synthesize:async()=>{throw new Error('tts down');}});
  const res=await app.inject({method:'POST',url:'/model/v1/speech',payload:{text:'长'.repeat(100),summarize:true}});
  assert.equal(res.statusCode,502);
  const body=res.json();
  assert.equal(body.error.code,'SPEECH_UNAVAILABLE');
  assert.equal(body.error.spoken_text,'改写后的口播。');
  await app.close();
});
test('speech route: validation and empty-after-sanitize',async()=>{
  const app=await appWith({synthesize:async()=>Buffer.from('a')});
  assert.equal((await app.inject({method:'POST',url:'/model/v1/speech',payload:{text:''}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/model/v1/speech',payload:{text:'ok',voice:'other'}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/model/v1/speech',payload:{text:'```\ncode only\n```'}})).statusCode,400);
  await app.close();
});

test('persona speech rewrites mechanical short receipts and strips stage parens',async()=>{
  assert.equal(sanitizeSpeech('哼，办妥啦（轻拍尾巴）！'), '哼，办妥啦 ！');
  assert.equal(needsSummary('跨设备任务完成啦：/Users/demo/test.txt', '跨设备任务完成啦：/Users/demo/test.txt', 'persona'), true);
  let capturedPrompt='';
  const app=Fastify();
  registerSpeech(app,{deepseekApiKey:'',deepseekBaseUrl:'https://unused'} as any,{content:'你是蓝色大肥鱼鲸鱼娘'},{
    summarize:async(_text,prompt)=>{ capturedPrompt=prompt; return '哼，主人，电脑那边的文件我已经帮你挪好啦！'; },
    synthesize:async()=>Buffer.from('ID3persona'),
  });
  const res=await app.inject({method:'POST',url:'/model/v1/speech',payload:{text:'已写入 /Users/demo/hello.txt',summarize:true,rewrite:'always',style:'persona',voice:'sweet-lively'}});
  assert.equal(res.statusCode,200);
  const body=res.json();
  assert.equal(body.rewritten,true);
  assert.equal(body.spoken_text,'哼，主人，电脑那边的文件我已经帮你挪好啦！');
  assert.ok(capturedPrompt.includes('大肥鱼') && capturedPrompt.includes('你是蓝色大肥鱼鲸鱼娘'));
  await app.close();
});

test('audio status and transcription route support OpenAI-compatible ASR and report 503 when unconfigured',async()=>{
  const unconfigured=await appWith({});
  const st0=await unconfigured.inject({method:'GET',url:'/model/v1/audio/status'});
  assert.equal(st0.statusCode,200);assert.equal(st0.json().asr_enabled,false);
  const res0=await unconfigured.inject({method:'POST',url:'/model/v1/audio/transcriptions',payload:{audio_base64:Buffer.alloc(64,1).toString('base64')}});
  assert.equal(res0.statusCode,503);assert.equal(res0.json().error.code,'ASR_NOT_CONFIGURED');
  await unconfigured.close();

  const app=Fastify();
  let capturedBytes=0;
  registerSpeech(app,{deepseekApiKey:'',deepseekBaseUrl:'https://unused',asrModel:'SenseVoiceSmall'} as any,null,{
    transcribe:async(audio,opts)=>{ capturedBytes=audio.length; return {text:`识别结果(${opts.language})`,model:'SenseVoiceSmall'}; },
  });
  const st=await app.inject({method:'GET',url:'/model/v1/audio/status'});
  assert.equal(st.json().asr_enabled,true);assert.equal(st.json().asr_model,'SenseVoiceSmall');
  const res=await app.inject({method:'POST',url:'/model/v1/audio/transcriptions',payload:{audio_base64:Buffer.alloc(128,7).toString('base64'),format:'wav',language:'zh'}});
  assert.equal(res.statusCode,200);
  assert.equal(capturedBytes,128);
  assert.equal(res.json().text,'识别结果(zh)');
  await app.close();
});


test('speech prefers Momo WAV and reports the actual voice without exposing credentials',async()=>{
  let oldCalls=0;
  const app=await appWith({qwenSynthesize:async()=>Buffer.from('RIFFcloud'),synthesize:async()=>{oldCalls++;return Buffer.from('old');}});
  const response=await app.inject({method:'POST',url:'/model/v1/speech',payload:{text:'你好呀',rewrite:'never'}});
  assert.equal(response.statusCode,200);const body=response.json();
  assert.equal(body.provider,'qwen');assert.equal(body.resolved_voice,'Momo');assert.equal(body.format,'wav');assert.equal(body.fallback,false);assert.equal(oldCalls,0);
  const status=(await app.inject('/model/v1/audio/status')).json();
  assert.equal(status.tts_provider,'qwen');assert.deepEqual(status.tts_fallbacks,['microsoft','system']);
  await app.close();
});
test('Momo failure falls back once to original Microsoft with the same rewritten utterance',async()=>{
  const requests:string[]=[];
  const app=await appWith({summarize:async()=>'我在听呢。',qwenSynthesize:async(text:string)=>{requests.push('qwen:'+text);throw new Error('provider down');},synthesize:async(text:string)=>{requests.push('microsoft:'+text);return Buffer.from('old');}});
  const result=await app.inject({method:'POST',url:'/model/v1/speech',payload:{text:'原始回复',rewrite:'always'}});
  const body=result.json();assert.equal(body.provider,'microsoft');assert.equal(body.format,'mp3');assert.equal(body.fallback,true);
  assert.deepEqual(requests,['qwen:我在听呢。','microsoft:我在听呢。']);await app.close();
});
test('empty cloud sound falls back, both providers failing retains words for original system TTS',async()=>{
  const app=await appWith({qwenSynthesize:async()=>Buffer.alloc(0),synthesize:async()=>{throw new Error('offline');}});
  const result=await app.inject({method:'POST',url:'/model/v1/speech',payload:{text:'请看屏幕',rewrite:'never'}});
  assert.equal(result.statusCode,502);assert.equal(result.json().error.spoken_text,'请看屏幕');assert.ok(!result.body.includes('offline'));await app.close();
});
test('legacy voice profiles stay usable when Momo is configured',async()=>{
  let qwenCalls=0;
  const app=await appWith({qwenSynthesize:async()=>{qwenCalls++;return Buffer.from('cloud');},synthesize:async()=>Buffer.from('old')});
  const result=await app.inject({method:'POST',url:'/model/v1/speech',payload:{text:'你好',voice:'sweet-warm',rewrite:'never'}});
  assert.equal(result.json().provider,'microsoft');assert.equal(result.json().resolved_voice,'zh-CN-XiaoxiaoNeural');assert.equal(qwenCalls,0);await app.close();
});

test('disconnect aborts cloud synthesis and never starts Microsoft fallback',async()=>{
  let started!:()=>void,aborted!:()=>void,oldCalls=0;
  const began=new Promise<void>(resolve=>{started=resolve;});const cancelled=new Promise<void>(resolve=>{aborted=resolve;});
  const app=await appWith({qwenSynthesize:async(_text:string,signal:AbortSignal)=>new Promise<Buffer>((_resolve,reject)=>{
    signal.addEventListener('abort',()=>{aborted();reject(new Error('cancelled'));},{once:true});started();
  }),synthesize:async()=>{oldCalls++;return Buffer.from('old');}});
  try {
    await app.listen({host:'127.0.0.1',port:0});const port=(app.server.address() as any).port;
    const controller=new AbortController();
    const request=fetch(`http://127.0.0.1:${port}/model/v1/speech`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'你好呀',rewrite:'never'}),signal:controller.signal}).catch(()=>null);
    await began;controller.abort();await request;
    await Promise.race([cancelled,new Promise((_,reject)=>setTimeout(()=>reject(new Error('upstream was not cancelled')),1000).unref())]);
    assert.equal(oldCalls,0);
  } finally {await app.close();}
});

test('streaming speech delivers first PCM before synthesis completes and retains explicit done',async()=>{
  let finish!:()=>void;const gate=new Promise<void>(resolve=>{finish=resolve;});
  const pcm=Buffer.alloc(4800,1);
  const app=await appWith({qwenSynthesize:async(_text:string,_signal:AbortSignal,onPcm:(pcm:Buffer)=>void)=>{onPcm(pcm);await gate;onPcm(pcm);return Buffer.from('complete');}});
  try {
    await app.listen({host:'127.0.0.1',port:0});const port=(app.server.address() as any).port;
    const response=await fetch(`http://127.0.0.1:${port}/model/v1/speech`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/x-ndjson'},body:JSON.stringify({text:'我在听呢。',rewrite:'never'})});
    assert.equal(response.headers.get('content-type'),'application/x-ndjson');
    const reader=response.body!.getReader();const first=new TextDecoder().decode((await reader.read()).value);
    assert.ok(first.includes('"type":"start"'));assert.ok(first.includes('"type":"audio"'));assert.ok(!first.includes('"type":"done"'));
    finish();let tail='';while(true){const next=await reader.read();if(next.done)break;tail+=new TextDecoder().decode(next.value);}
    assert.ok(tail.includes('"type":"done"'));assert.ok(tail.includes('"frames":4800'));
  } finally {finish();await app.close();}
});
test('stream interruption after first PCM never changes voice or replays via Microsoft',async()=>{
  let oldCalls=0;
  const app=await appWith({qwenSynthesize:async(_text:string,_signal:AbortSignal,onPcm:(pcm:Buffer)=>void)=>{onPcm(Buffer.alloc(4800));throw new Error('broken stream');},synthesize:async()=>{oldCalls++;return Buffer.from('old');}});
  const response=await app.inject({method:'POST',url:'/model/v1/speech',headers:{accept:'application/x-ndjson'},payload:{text:'我在听呢。',rewrite:'never'}});
  const events=response.body.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(events[0].provider,'qwen');assert.equal(events.at(-1).type,'error');assert.equal(oldCalls,0);assert.ok(!response.body.includes('broken stream'));await app.close();
});
test('a pinned original voice skips Qwen for the rest of a reply, preserving the JSON fallback contract',async()=>{
  let cloudCalls=0;
  const app=await appWith({qwenSynthesize:async()=>{cloudCalls++;return Buffer.from('cloud');},synthesize:async()=>Buffer.from('old')});
  const response=await app.inject({method:'POST',url:'/model/v1/speech',headers:{accept:'application/x-ndjson','x-anylink-speech-provider':'microsoft'},payload:{text:'下一句。',rewrite:'never'}});
  assert.equal(response.json().provider,'microsoft');assert.equal(response.json().fallback,true);assert.equal(cloudCalls,0);await app.close();
});
