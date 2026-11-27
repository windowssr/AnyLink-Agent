import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../web/avatar-loader.js',import.meta.url),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  const scripts=[],timers=new Map(),events={};let nextTimer=0;
  const window={};
  vm.runInNewContext(source,{
    window,console:{info(){},error(){}},
    addEventListener:(event,handler)=>events[event]=handler,
    setTimeout:callback=>{timers.set(++nextTimer,callback);return nextTimer;},
    clearTimeout:id=>timers.delete(id),
    document:{createElement:()=>({remove(){this.removed=true;}}),body:{appendChild:script=>scripts.push(script)}},
  });
  return {window,scripts,timers,events};
}
test('character bootstrap loads libraries in order and exposes status independently of console callbacks',async()=>{
  const f=fixture();
  for(const [index,file] of ['live2dcubismcore.min.js','pixi.min.js','cubism4-colors.min.js','avatar.js'].entries()){
    assert.equal(f.scripts.length,index+1);assert.equal(f.scripts[index].src,'./'+file);
    f.scripts[index].onload();await flush();
  }
  assert.equal(f.timers.size,0);
  f.window.anylinkAvatarReport('ready','Live2D 已就绪');
  assert.equal(f.window.anylinkAvatarStatus.state,'ready');
  // A late nonessential rejection must not replace a working model with a fallback.
  f.events.unhandledrejection({reason:new Error('optional gesture')});
  assert.equal(f.window.anylinkAvatarStatus.state,'ready');
});
test('missing or blocked runtime stops bootstrap and identifies the failing script',async()=>{
  const f=fixture();f.scripts[0].onerror();await flush();
  assert.equal(f.window.anylinkAvatarStatus.state,'failed');
  assert.match(f.window.anylinkAvatarStatus.message,/live2dcubismcore.min.js 加载失败/);
  assert.equal(f.scripts.length,1);assert.equal(f.timers.size,0);
});
test('stalled script has a deadline even when the browser sends neither load nor error',async()=>{
  const f=fixture();[...f.timers.values()][0]();await flush();
  assert.equal(f.scripts[0].removed,true);
  assert.equal(f.window.anylinkAvatarStatus.state,'failed');
  assert.match(f.window.anylinkAvatarStatus.message,/加载超时/);
  assert.equal(f.scripts.length,1);
});
test('syntax and startup promise errors surface before avatar.js can send a ready message',async()=>{
  for(const [event,payload] of [['error',{message:'Unexpected token ?'}],['unhandledrejection',{reason:new Error('core init failed')}]]){
    const f=fixture();f.events[event](payload);f.scripts[0].onload();await flush();
    assert.equal(f.window.anylinkAvatarStatus.state,'failed');assert.equal(f.scripts.length,1);
    assert.match(f.window.anylinkAvatarStatus.message,/Unexpected token|core init failed/);
  }
});
