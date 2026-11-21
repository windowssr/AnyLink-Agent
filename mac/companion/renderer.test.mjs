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
  const context={window,innerWidth:280,innerHeight:402,devicePixelRatio:2,performance,document:{body:{append:noOp}},setTimeout,
    PIXI:{Application:class{view={};stage={addChild:noOp};ticker={add:noOp};},Ticker:{shared:{}},UPDATE_PRIORITY:{LOW:-25},live2d:{Live2DModel:{from:async()=>model}}}};
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
});
