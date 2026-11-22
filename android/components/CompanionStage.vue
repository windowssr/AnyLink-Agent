<template>
  <view class="stage" :data-state="state" :change:data-state="portrait.update">
    <view class="halo"></view>
    <image v-if="!ready" class="placeholder" src="/static/avatar.png" mode="aspectFit" />
    <view id="anylink-mobile-character" class="character"></view>
    <view class="floor"></view>
  </view>
</template>
<script>
export default {
  props: {state: {type: Object, default: () => ({})}},
  data: () => ({ready: false}),
  methods: {rendererReady(value) { this.ready = value; this.$emit('ready', value); }},
};
</script>
<script module="portrait" lang="renderjs">
let app, model, owner, observer, pending = {}, stopped = false, actionEpoch = 0, nodUntil = 0, lastAction;
function load(src) { return new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = src; script.onload = resolve; script.onerror = reject; document.head.appendChild(script); }); }
export default {
  mounted() { owner = this.$ownerInstance; this.start(); },
  beforeUnmount() { stopped = true; observer?.disconnect(); app?.destroy(true, {children: true, texture: true, baseTexture: true}); },
  methods: {
    async start() {
      try {
        const base = './static/companion/';
        await load(base + 'live2dcubismcore.min.js'); await load(base + 'pixi.min.js'); await load(base + 'cubism4-colors.min.js');
        if (stopped) return;
        const host = document.getElementById('anylink-mobile-character'), width = host.clientWidth, height = host.clientHeight;
        app = new PIXI.Application({width, height, backgroundAlpha: 0, antialias: true, autoDensity: true, resolution: Math.min(devicePixelRatio, 1.5)});
        app.ticker.maxFPS = 24; PIXI.Ticker.shared.maxFPS = 24; host.appendChild(app.view);
        model = await PIXI.live2d.Live2DModel.from(base + 'model/entry.model3.json', {autoInteract: false});
        model.anchor.set(0.5, 1); app.stage.addChild(model);
        const fit = () => { const w = host.clientWidth, h = host.clientHeight; app.renderer.resize(w, h); model.scale.set(1); model.scale.set(Math.min(w * 0.9 / model.width, (h - 8) / model.height)); model.position.set(w / 2, h - 6); };
        fit(); if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(fit); observer.observe(host); }
        model.internalModel.on('beforeModelUpdate', () => { if (performance.now() < nodUntil) model.internalModel.coreModel.setParameterValueById('ParamAngleY', Math.sin((nodUntil - performance.now()) / 120) * 8); });
        owner.callMethod('rendererReady', true); this.update(pending);
        document.addEventListener('visibilitychange', () => { if (document.hidden) app?.stop(); else app?.start(); });
      } catch { owner.callMethod('rendererReady', false); }
    },
    update(value) {
      pending = value ?? {}; if (!model) return;
      if (pending.paused) app.stop(); else app.start();
      model.internalModel.motionManager.expressionManager?.resetExpression();
      const expression = {happy: 'blush', excited: 'smile', apologetic: 'concerned'}[pending.emotion]; if (expression) model.expression(expression);
      if (!pending.gesture || pending.gesture === 'none' || pending.sequence === lastAction) return;
      lastAction = pending.sequence;
      if (pending.gesture === 'nod') { nodUntil = performance.now() + 1500; return; }
      const group = {wave: 'Wave', point: 'Point'}[pending.gesture], epoch = ++actionEpoch;
      if (group) { model.motion(group, 0, 3); setTimeout(() => { if (model && epoch === actionEpoch) model.motion(group + 'Return', 0, 3); }, 4500); }
    },
  },
};
</script>
<style scoped>
.stage { position: relative; width: 100%; height: 100%; overflow: hidden; }
.halo { position: absolute; width: 430rpx; height: 430rpx; border-radius: 50%; background: radial-gradient(circle, #fff 10%, #dceeff99 62%, transparent 72%); left: 50%; top: 15rpx; transform: translateX(-50%); }
.character { position: absolute; inset: 0; z-index: 2; }
.placeholder { position: absolute; height: 90%; width: 100%; bottom: 4%; z-index: 1; mix-blend-mode: multiply; }
.floor { position: absolute; bottom: 0; width: 190rpx; height: 22rpx; border-radius: 50%; background: #8fbbda33; left: 50%; transform: translateX(-50%); }
</style>
