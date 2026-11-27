import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../web/avatar.js',import.meta.url),'utf8');
async function renderFixture({layoutHeight=800,pixels=true}={}){
  const bounds=()=>({width:360,height:layoutHeight}),stats={resizes:0,renders:0},signals=[];
  let complete;
  const done=new Promise(resolve=>complete=resolve);
  const view={style:{},addEventListener(){},getBoundingClientRect:bounds};
  const model={width:400,height:1600,anchor:{set(){}},scale:{set(){}},position:{set(){}},update(){},
    textures:[{valid:true}],internalModel:{on(){},coreModel:{getParameterIndex:()=>-1,getParameterCount:()=>0},motionManager:{}}};
  const gl={drawingBufferWidth:540,drawingBufferHeight:1200,isContextLost:()=>false,finish(){},readPixels(x,y,w,h,format,type,value){value[3]=pixels?255:0;}};
  const window={anylinkAvatarReport(state,message){signals.push({state,message});if(state==='ready'||state==='failed')complete();}};
  const document={documentElement:{clientWidth:360,clientHeight:800,getBoundingClientRect:bounds},body:{appendChild(){},getBoundingClientRect:bounds},hidden:false,addEventListener(){}};
  class Application {
    constructor(){this.view=view;this.ticker={};this.stage={addChild(){}};this.renderer={width:540,height:1200,gl,resize(){stats.resizes++;},render(){stats.renders++;}};}
    start(){}
    stop(){}
  }
  vm.runInNewContext(source,{window,document,console:{info(){},warn(){},error(){}},performance:{now:()=>100},devicePixelRatio:3.25,
    PIXI:{Application,Ticker:{shared:{}},live2d:{Live2DModel:{from:async()=>model}}},Live2DCubismCore:{},
    location:{search:''},URLSearchParams,addEventListener(){},setTimeout:callback=>setImmediate(callback),Uint8Array});
  let timer;
  try{await Promise.race([done,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Avatar did not finish startup')),2000))]);}
  finally{clearTimeout(timer);}
  return {signals,stats,window};
}

test('valid model and GPU pixels cannot report ready when the document clips the canvas to zero height',async()=>{
  const {signals,stats}=await renderFixture({layoutHeight:0});
  assert.equal(signals.at(-1).state,'failed');
  assert.equal(signals.at(-1).message,'blank_webgl_surface');
  assert.equal(signals.some(signal=>signal.state==='ready'),false);
  assert.equal(stats.renders,16);
});

test('valid textures without any rendered pixels cannot report ready',async()=>{
  const {signals}=await renderFixture({pixels:false});
  assert.equal(signals.at(-1).state,'failed');
  assert.equal(signals.some(signal=>signal.state==='ready'),false);
});

test('visible layout and rendered pixels report ready without repeated resizing at fractional density',async()=>{
  const {signals,stats,window}=await renderFixture();
  assert.equal(signals.at(-1).state,'ready');
  assert.equal(stats.resizes,1);
  window.anylinkMobileAvatar.update({phase:'idle',safeBottom:100});
  assert.equal(stats.resizes,1);
});
