/* No chat, credentials, audio, screen capture or remote requests enter this renderer. */
(() => {
  const send = value => window.webkit?.messageHandlers.anylinkAvatar.postMessage(value);
  window.addEventListener('error',() => send({type:'error',code:'renderer_failed'}));
  let model, app, ready = false, input = {mood:'idle',emotion:'neutral',x:-1,y:-1,reducedMotion:false,speaking:false,walking:false,direction:1,activity:'resting',look:0}, lastMood, lastHit = false, actionEpoch = 0, activeGroup;
  const activities = new Set(['resting','attending','thinking','executing','attention','presenting','cancelling','cancelled','unknown']);
  const emotions = new Set(['neutral','happy','excited','comfort','curious','apologetic']);
  const allowedMoods = new Set(['idle','thinking','working','attention','finished','offline','happy','sleepy']);
  const resetExpression = () => model?.internalModel.motionManager.expressionManager?.resetExpression();
  function fit() {
    if (!model) return;
    model.scale.set(1);
    const scale = Math.min((innerWidth-8)/model.width,(innerHeight-8)/model.height);
    model.scale.set(scale); model.position.set(innerWidth/2,innerHeight-4);
  }
  async function action(name) {
    if (!ready || input.reducedMotion || !['wave','point','nod','attend','resume'].includes(name)) return;
    const epoch = ++actionEpoch;
    if (['nod','attend','resume'].includes(name)) {
      nodStarted = performance.now(); nodDuration = name==='nod'?950:650;
      if (activeGroup) {
        const returning=activeGroup+'Return';activeGroup=undefined;
        const motion=await model.internalModel.motionManager.loadMotion(returning,0);motion?.setIsLoop(false);
        if(actionEpoch===epoch)await model.motion(returning,0,3);
      }
      send({type:'action',name}); return;
    }
    const group = name === 'wave' ? 'Wave' : 'Point';
    const motion = await model.internalModel.motionManager.loadMotion(group,0);
    motion?.setIsLoop(false);
    if (actionEpoch !== epoch) return;
    const started = await model.motion(group,0,3);
    if (started) { activeGroup=group; send({type:'action',name}); }
    setTimeout(async () => {
      if (actionEpoch !== epoch) return;
      const returning = await model.internalModel.motionManager.loadMotion(group+'Return',0);
      returning?.setIsLoop(false);
      if (actionEpoch === epoch) { await model.motion(group+'Return',0,3); activeGroup=undefined; }
    },name==='point'?2200:2800);
  }
  let nodStarted = -10000, nodDuration = 950;
  window.anylinkAvatar = {
    update(value) {
      if (!value || !allowedMoods.has(value.mood)) return;
      input = {mood:value.mood,emotion:emotions.has(value.emotion)?value.emotion:'neutral',x:Number.isFinite(value.x)?value.x:-1,y:Number.isFinite(value.y)?value.y:-1,reducedMotion:!!value.reducedMotion,speaking:!!value.speaking,walking:!!value.walking,direction:value.direction===-1?-1:1,entrance:Number.isFinite(value.entrance)?Math.max(0,Math.min(1,value.entrance)):1,portal:!!value.portal,activity:activities.has(value.activity)?value.activity:'resting',look:value.look===-1?-1:(value.look===1?1:0)};
      if (!ready) return;
      const appearing=input.entrance;
      app.view.style.opacity=String(appearing);
      app.view.style.transform=input.reducedMotion?'none':`translateY(${(1-appearing)*20}%) scale(${0.68+appearing*0.32})`;
      document.body.classList.toggle('entering',input.portal&&!input.reducedMotion);
      document.body.classList.toggle('reduced',input.reducedMotion);
      const expressionKey = input.mood+':'+input.emotion;
      if (expressionKey !== lastMood) {
        lastMood = expressionKey; resetExpression();
        const expression = {happy:'blush',excited:'smile',apologetic:'concerned'}[input.emotion] ?? {happy:'blush',attention:'concerned',finished:'smile'}[input.mood];
        if (expression) model.expression(expression);
      }
      // The library setter registers a ticker listener each time. Only toggle
      // on a state change; repeating it every native mouse update races motions.
      if (model.autoUpdate === input.reducedMotion) model.autoUpdate = !input.reducedMotion;
      if(input.reducedMotion)model.internalModel.focusController.focus(0,0);
    },
    action,
  };
  async function start() {
    app = new PIXI.Application({width:innerWidth,height:innerHeight,resizeTo:window,backgroundAlpha:0,antialias:true,autoDensity:true,resolution:Math.min(devicePixelRatio,2),preserveDrawingBuffer:true});
    app.ticker.maxFPS = 24; PIXI.Ticker.shared.maxFPS = 24; document.body.append(app.view);
    model = await PIXI.live2d.Live2DModel.from('../model/entry.model3.json',{autoInteract:false});
    model.anchor.set(0.5,1); app.stage.addChild(model); fit();
    window.addEventListener('resize',fit);
    const internal = model.internalModel, core = internal.coreModel;
    const ids = ['ParamAngleY','ParamAngleZ','ParamBodyAngleZ','HipAngleX','LEGAngleZ2','ParamMouthOpenY'];
    const available = new Set(ids.filter(id=>core.getParameterIndex(id)<core.getParameterCount()));
    const set = (id,value) => {if(available.has(id))core.setParameterValueById(id,value);};
    const pose={focusX:0,focusY:0,tilt:0,pitch:0,body:0,hips:0,legs:0,bounce:0,mouth:0};let previous=performance.now();
    internal.on('beforeModelUpdate',() => {
      const t = performance.now(),dt=Math.min(100,Math.max(0,t-previous));previous=t;
      const approach=(key,target,speed=230)=>pose[key]+=(target-pose[key])*(1-Math.exp(-dt/speed));
      set('ParamMouthOpenY',approach('mouth',input.speaking?0.18+Math.abs(Math.sin(t/94))*0.50:0,65));
      if (input.reducedMotion) return;
      const engaged=input.activity!=='resting',busy=['thinking','executing'].includes(input.activity);
      const gazeToCard=input.activity==='presenting'?input.look*0.24:0;
      const pointerX=Math.max(-0.35,Math.min(0.35,(input.x-innerWidth/2)/innerWidth));
      const pointerY=Math.max(-0.25,Math.min(0.25,(innerHeight/2-input.y)/innerHeight));
      internal.focusController.focus(approach('focusX',engaged?(gazeToCard+(busy?Math.sin(t/3100)*0.06:0)):pointerX,engaged?150:380),approach('focusY',engaged?(busy?-0.10:0.04):pointerY));
      const nodProgress=(t-nodStarted)/nodDuration,nod=nodProgress>0&&nodProgress<1?-Math.sin(nodProgress*Math.PI*2)*5*Math.sin(nodProgress*Math.PI):0;
      set('ParamAngleY',approach('pitch',nod+(busy?-2:input.emotion==='comfort'?-4:0),100));
      set('ParamAngleZ',approach('tilt',input.emotion==='curious'?3.5:(engaged?input.look*0.8:Math.sin(t/5300)*0.6),420));
      const stride=input.walking?Math.sin(t/260):0;
      if(!activeGroup){set('ParamBodyAngleZ',approach('body',stride*1.2+(engaged?0:Math.sin(t/4200)*0.35),350));set('HipAngleX',approach('hips',stride*2.1,240));set('LEGAngleZ2',approach('legs',stride*1.6,240));}
      model.y=innerHeight-4-approach('bounce',input.walking?Math.abs(stride)*2:0,200);
    });
    // Sample our transparent WebGL canvas only, never the desktop. The native
    // window uses this single alpha value to pass empty pixels through.
    let sampledAt = 0;
    app.ticker.add(() => {
      if (performance.now()-sampledAt < 65) return; sampledAt = performance.now();
      const gl = app.renderer.gl, r = app.renderer.resolution, pixel = new Uint8Array(4);
      const x = Math.floor(input.x*r), y = Math.floor((innerHeight-input.y)*r);
      let hit = false;
      if (x>=0 && y>=0 && x<gl.drawingBufferWidth && y<gl.drawingBufferHeight) {
        gl.readPixels(x,y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel); hit = pixel[3]>30;
      }
      if (hit !== lastHit) { lastHit=hit; send({type:'hit',value:hit}); }
    },undefined,PIXI.UPDATE_PRIORITY.LOW-1);
    ready = true; send({type:'ready',actions:['wave','point','nod'],engine:'Live2D'});
  }
  start().catch(() => send({type:'error',code:'model_load_failed'}));
})();
