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
async function appWith(deps:{summarize?:any;synthesize?:any}){
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
