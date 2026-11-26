import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

test('frequent native pointer updates do not accumulate animation ticker registrations',async()=>{
  const messages=[],noOp=()=>{};let registrations=0,autoUpdate=true;
  const model={width:100,height:200,anchor:{set:noOp},scale:{set:noOp},position:{set:noOp},
    get autoUpdate(){return autoUpdate;},set autoUpdate(value){registrations++;autoUpdate=value;},
    internalModel:{on:noOp,coreModel:{getParameterIndex:()=>0,getParameterCount:()=>1},focusController:{focus:noOp},motionManager:{expressionManager:{resetExpression:noOp}}},expression:noOp};
  const window={webkit:{messageHandlers:{anylinkAvatar:{postMessage:value=>messages.push(value)}}},addEventListener:noOp};
  const canvas={style:{}},classes=new Set();
  const context={window,innerWidth:280,innerHeight:402,devicePixelRatio:2,performance,document:{body:{append:noOp,classList:{toggle:(key,on)=>on?classes.add(key):classes.delete(key)}}},setTimeout,
    PIXI:{Application:class{view=canvas;stage={addChild:noOp};ticker={add:noOp};},Ticker:{shared:{}},UPDATE_PRIORITY:{LOW:-25},live2d:{Live2DModel:{from:async()=>model}}}};
  vm.runInNewContext(await fs.readFile(new URL('./web/app.js',import.meta.url),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(messages.some(value=>value.type==='ready'));
  const update=value=>window.anylinkAvatar.update({mood:'idle',x:120,y:200,reducedMotion:value});
  for(let i=0;i<1000;i++)update(false);
  assert.equal(registrations,0,'Repeated input must not add ticker listeners');
  for(let i=0;i<1000;i++)update(true);
  assert.equal(registrations,1);assert.equal(model.autoUpdate,false);
  for(let i=0;i<1000;i++)update(false);
  assert.equal(registrations,2);assert.equal(model.autoUpdate,true);
  assert.equal(context.PIXI.Ticker.shared.maxFPS,24);
  window.anylinkAvatar.update({mood:'idle',entrance:0.4,portal:true,reducedMotion:false});
  assert.equal(canvas.style.opacity,'0.4');assert.ok(classes.has('entering'));
  window.anylinkAvatar.update({mood:'idle',entrance:1,portal:false,reducedMotion:true});
  assert.equal(canvas.style.opacity,'1');assert.equal(canvas.style.transform,'none');assert.ok(!classes.has('entering'));
});
test('attention and result gaze ease between poses and return to rest without cursor snapping',async()=>{
  let tick,time=0;const noOp=()=>{},focus=[],parameters=new Map();
  const model={width:100,height:200,anchor:{set:noOp},scale:{set:noOp},position:{set:noOp},autoUpdate:true,
    internalModel:{on:(_event,callback)=>tick=callback,coreModel:{getParameterIndex:()=>0,getParameterCount:()=>1,setParameterValueById:(id,value)=>parameters.set(id,value)},focusController:{focus:(x,y)=>focus.push([x,y])},motionManager:{expressionManager:{resetExpression:noOp}}},expression:noOp};
  const window={webkit:{messageHandlers:{anylinkAvatar:{postMessage:noOp}}},addEventListener:noOp};
  const context={window,innerWidth:280,innerHeight:440,devicePixelRatio:1,performance:{now:()=>time},document:{body:{append:noOp,classList:{toggle:noOp}}},setTimeout,
    PIXI:{Application:class{view={style:{}};stage={addChild:noOp};ticker={add:noOp};},Ticker:{shared:{}},UPDATE_PRIORITY:{LOW:-25},live2d:{Live2DModel:{from:async()=>model}}}};
  vm.runInNewContext(await fs.readFile(new URL('./web/app.js',import.meta.url),'utf8'),context);await new Promise(resolve=>setImmediate(resolve));
  const step=()=>{time+=42;tick();};
  window.anylinkAvatar.update({mood:'happy',activity:'attending',x:20000,y:20000,look:1});for(let i=0;i<30;i++)step();
  assert.ok(Math.abs(focus.at(-1)[0])<0.01,'Calling her looks toward user, not an offscreen pointer');
  window.anylinkAvatar.update({mood:'finished',activity:'presenting',look:1});step();
  assert.ok(focus.at(-1)[0]>0&&focus.at(-1)[0]<0.1,'Result gaze starts with a blended transition');
  for(let i=0;i<30;i++)step();assert.ok(focus.at(-1)[0]>0.23);
  window.anylinkAvatar.update({mood:'idle',activity:'resting',x:0,y:220});step();assert.ok(focus.at(-1)[0]>0.1,'Return does not snap');
  for(let i=0;i<70;i++)step();assert.ok(focus.at(-1)[0]<-0.34);
  assert.ok(Math.abs(parameters.get('ParamAngleZ'))<1,'Resting posture settles to a subtle idle pose');
});
