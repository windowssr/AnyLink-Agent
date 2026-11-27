/* This view receives presentation state only. No text, credentials, microphone,
   model access or Android execution bridge is exposed to the character. */
(() => {
  const phases = new Set(['idle', 'listening', 'thinking', 'working', 'speaking', 'attention']);
  const emotions = new Set(['neutral', 'happy', 'curious', 'comfort', 'apologetic', 'excited', 'shy']);
  let app, model, ready = false, paused = false, expressionKey = '', gestureSequence, actionEpoch = 0;
  let state = {phase: 'idle', emotion: 'neutral', level: 0, reducedMotion: false, safeTop: 0, safeBottom: 0, mini: false};
  let touch = 0, lastFrame = performance.now(), baseWidth = 0, baseHeight = 0;
  const pose = {x: 0, y: 0, tilt: 0, pitch: 0, mouth: 0, body: 0};

  function viewportSize() {
    const w = Math.max(1, Math.round(document.documentElement.clientWidth || window.innerWidth || 1));
    const h = Math.max(1, Math.round(document.documentElement.clientHeight || window.innerHeight || 1));
    return {w, h};
  }

  function fit() {
    if (!model || !app) return;
    const {w, h} = viewportSize();
    if (w < 16 || h < 16) return;
    app.renderer.resize(w, h);
    if (!baseWidth || !baseHeight) {
      model.scale.set(1);
      baseWidth = Math.max(1, model.width);
      baseHeight = Math.max(1, model.height);
    }
    const mw = baseWidth, mh = baseHeight;
    // Full-bleed deep-sea portrait framing:
    // - Companion mode (!mini): place 大肥鱼 head, maid headdress, whale ears & upper torso
    //   centered cleanly in the upper 54% of the screen, unobstructed above the glass chat sheet.
    // - Reading / keyboard mode (mini): gently scale down and lift slightly so her face peeks above the sheet.
    const safeTop = Math.max(24, Math.min(state.safeTop || 42, h * 0.14));
    const targetScale = state.mini
      ? Math.min((w * 0.86) / mw, (h * 0.72) / mh)
      : Math.min((w * 1.32) / mw, Math.max((w * 0.96) / mw, (h * 0.96) / mh));
    model.scale.set(targetScale);
    // Lift framing slightly so her head & eyes sit in the optical center above the glass sheet
    // (compensating for the model canvas's built-in transparent top headroom).
    const yPos = state.mini ? safeTop - h * 0.065 : safeTop - h * 0.015;
    model.position.set(w / 2, yPos);
  }

  /** Sample the WebGL backbuffer to verify non-transparent pixels were actually drawn before dismissing Android fallback. */
  function hasRenderedPixels() {
    try {
      const gl = app?.renderer?.gl;
      if (!gl || gl.isContextLost?.()) return false;
      const bw = gl.drawingBufferWidth | 0;
      const bh = gl.drawingBufferHeight | 0;
      if (bw < 16 || bh < 16) return false;
      const px = new Uint8Array(4);
      let hits = 0;
      for (let gx = 1; gx <= 7; gx++) {
        for (let gy = 1; gy <= 7; gy++) {
          const x = Math.floor((bw * gx) / 8);
          const y = Math.floor((bh * gy) / 8);
          gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          if (px[3] > 20) {
            hits++;
            if (hits >= 3) return true;
          }
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async function gesture(name) {
    if (!ready || state.reducedMotion) return;
    const group = {wave: 'Wave', point: 'Point'}[name];
    if (!group) { if (name === 'nod') touch = performance.now(); return; }
    const epoch = ++actionEpoch, manager = model.internalModel.motionManager;
    try {
      const motion = await manager.loadMotion(group, 0); motion?.setIsLoop(false);
      if (epoch !== actionEpoch || paused) return;
      await model.motion(group, 0, 3);
      setTimeout(async () => {
        if (epoch !== actionEpoch || paused) return;
        const returning = await manager.loadMotion(group + 'Return', 0); returning?.setIsLoop(false);
        if (epoch === actionEpoch) await model.motion(group + 'Return', 0, 3);
      }, name === 'point' ? 1800 : 2500);
    } catch { /* An unavailable gesture does not stop conversation or rendering. */ }
  }

  function apply() {
    if (!ready) return;
    const key = state.emotion + ':' + state.phase;
    if (key !== expressionKey) {
      expressionKey = key; model.internalModel.motionManager.expressionManager?.resetExpression();
      const expression = {happy: 'blush', shy: 'blush', excited: 'smile', apologetic: 'concerned'}[state.emotion] || (state.phase === 'attention' ? 'concerned' : undefined);
      if (expression) model.expression(expression);
    }
    if (state.sequence != null && state.sequence !== gestureSequence) { gestureSequence = state.sequence; gesture(state.gesture); }
    if (paused || document.hidden) app.stop(); else app.start();
  }

  window.anylinkMobileAvatar = {
    update(value) {
      if (!value || !phases.has(value.phase)) return;
      const dpr = window.devicePixelRatio || 1;
      state = {
        phase: value.phase,
        emotion: emotions.has(value.emotion) ? value.emotion : 'neutral',
        level: Number.isFinite(value.level) ? Math.max(0, Math.min(1, value.level)) : 0,
        reducedMotion: !!value.reducedMotion,
        gesture: value.gesture,
        sequence: value.sequence,
        safeTop: (Number(value.safeTop) || 0) / dpr,
        safeBottom: (Number(value.safeBottom) || 0) / dpr,
        mini: value.mini === true,
      };
      fit();
      paused = value.paused === true;
      apply();
    },
    nod() { touch = performance.now(); },
  };

  async function waitForVisibleFrame(maxAttempts = 6) {
    for (let i = 0; i < maxAttempts; i++) {
      fit();
      app.renderer.render(app.stage);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (hasRenderedPixels()) return true;
      await new Promise(r => setTimeout(r, 220));
    }
    return false;
  }

  async function start() {
    const {w, h} = viewportSize();
    app = new PIXI.Application({
      width: Math.max(w, 64),
      height: Math.max(h, 64),
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      preserveDrawingBuffer: true,
      resolution: Math.min(devicePixelRatio || 1, 1.5),
      powerPreference: 'default',
    });
    app.ticker.maxFPS = 24;
    PIXI.Ticker.shared.maxFPS = 24;
    document.body.appendChild(app.view);
    model = await PIXI.live2d.Live2DModel.from('./model/entry.model3.json', {autoInteract: false});
    model.anchor.set(0.5, 0);
    app.stage.addChild(model);
    fit();
    addEventListener('resize', fit);
    window.visualViewport?.addEventListener('resize', fit);
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => fit()).observe(document.body);
    }
    const internal = model.internalModel, core = internal.coreModel;
    const available = new Set(['ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleZ', 'ParamMouthOpenY'].filter(id => core.getParameterIndex(id) < core.getParameterCount()));
    const set = (id, value) => { if (available.has(id)) core.setParameterValueById(id, value); };
    internal.on('beforeModelUpdate', () => {
      const now = performance.now(), dt = Math.min(100, Math.max(0, now - lastFrame)); lastFrame = now;
      const ease = (key, target, duration = 260) => pose[key] += (target - pose[key]) * (1 - Math.exp(-dt / duration));
      const quiet = state.reducedMotion, busy = ['thinking', 'working'].includes(state.phase), listening = state.phase === 'listening';
      const nod = now - touch < 900 ? -Math.sin((now - touch) / 900 * Math.PI * 2) * 4 : 0;
      internal.focusController.focus(ease('x', quiet ? 0 : busy ? Math.sin(now / 3200) * 0.055 : Math.sin(now / 5900) * 0.02), ease('y', quiet ? 0 : busy ? -0.10 : listening ? 0.055 : 0));
      set('ParamAngleY', ease('pitch', quiet ? 0 : nod + (busy ? -2 : 0), 130));
      set('ParamAngleZ', ease('tilt', quiet ? 0 : listening ? 2.4 : state.emotion === 'curious' ? 3 : Math.sin(now / 5500) * 0.65, 420));
      set('ParamBodyAngleZ', ease('body', quiet ? 0 : Math.sin(now / 4300) * 0.35, 400));
      const mouth = state.phase === 'speaking' ? (state.level || (0.18 + Math.abs(Math.sin(now / 110)) * 0.38)) : 0;
      set('ParamMouthOpenY', ease('mouth', mouth, 65));
    });
    app.view.addEventListener('pointerup', () => { touch = performance.now(); });
    const canvas = app.view;
    let contextLost = false;
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault(); contextLost = true; ready = false; console.info('ANYLINK_AVATAR_CONTEXT_LOST');
      setTimeout(() => { if (contextLost) location.reload(); }, 2500);
    });
    canvas.addEventListener('webglcontextrestored', () => { contextLost = false; console.info('ANYLINK_AVATAR_CONTEXT_RESTORED'); location.reload(); });
    document.addEventListener('visibilitychange', apply);

    const visible = await waitForVisibleFrame(6);
    if (!visible) {
      console.error('ANYLINK_AVATAR_FAILED: blank_webgl_surface');
      return;
    }
    ready = true;
    apply();
    console.info('ANYLINK_AVATAR_READY');
  }

  start().catch((err) => {
    console.error('ANYLINK_AVATAR_FAILED: ' + (err && err.message ? err.message : String(err)));
  });
})();
