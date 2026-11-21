/* No chat, credentials, audio, screen capture or remote requests enter this renderer. */
(() => {
  const send = value => window.webkit?.messageHandlers.anylinkAvatar.postMessage(value);
  window.addEventListener('error',() => send({type:'error',code:'renderer_failed'}));
  let model, app, ready = false, input = {mood:'idle',x:-1,y:-1,reducedMotion:false}, lastMood, lastHit = false, actionEpoch = 0;
  const allowedMoods = new Set(['idle','thinking','working','attention','finished','offline','happy','sleepy']);
  const resetExpression = () => model?.internalModel.motionManager.expressionManager?.resetExpression();
  function fit() {
    if (!model) return;
    model.scale.set(1);
    const scale = Math.min((innerWidth-8)/model.width,(innerHeight-8)/model.height);
    model.scale.set(scale); model.position.set(innerWidth/2,innerHeight-4);
  }
  async function action(name) {
    if (!ready || input.reducedMotion || !['wave','point','nod'].includes(name)) return;
    const epoch = ++actionEpoch;
    if (name === 'nod') {
      nodUntil = performance.now()+1500; send({type:'action',name}); return;
    }
    const group = name === 'wave' ? 'Wave' : 'Point';
    const motion = await model.internalModel.motionManager.loadMotion(group,0);
    motion?.setIsLoop(false);
    if (actionEpoch !== epoch) return;
    const started = await model.motion(group,0,3);
    if (started) send({type:'action',name});
    setTimeout(async () => {
      if (actionEpoch !== epoch) return;
      const returning = await model.internalModel.motionManager.loadMotion(group+'Return',0);
      returning?.setIsLoop(false);
      if (actionEpoch === epoch) await model.motion(group+'Return',0,3);
    },4500);
  }
  let nodUntil = 0;
  window.anylinkAvatar = {
    update(value) {
      if (!value || !allowedMoods.has(value.mood)) return;
      input = {mood:value.mood,x:Number.isFinite(value.x)?value.x:-1,y:Number.isFinite(value.y)?value.y:-1,reducedMotion:!!value.reducedMotion};
      if (!ready) return;
      if (input.mood !== lastMood) {
        lastMood = input.mood; resetExpression();
        const expression = {happy:'blush',attention:'concerned',finished:'smile'}[input.mood];
        if (expression) model.expression(expression);
      }
      // The library setter registers a ticker listener each time. Only toggle
      // on a state change; repeating it every native mouse update races motions.
      if (model.autoUpdate === input.reducedMotion) model.autoUpdate = !input.reducedMotion;
      model.internalModel.focusController.focus(input.reducedMotion?0:Math.max(-0.35,Math.min(0.35,(input.x-innerWidth/2)/innerWidth)),input.reducedMotion?0:Math.max(-0.25,Math.min(0.25,(innerHeight/2-input.y)/innerHeight)));
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
    const hasAngleY = core.getParameterIndex('ParamAngleY') < core.getParameterCount();
    internal.on('beforeModelUpdate',() => {
      if (input.reducedMotion) return;
      const t = performance.now();
      if (nodUntil > t && hasAngleY) core.setParameterValueById('ParamAngleY',Math.sin((nodUntil-t)/120)*8);
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
