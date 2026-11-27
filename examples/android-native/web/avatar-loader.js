/* Run before the character libraries so a failed script cannot leave native UI loading forever. */
(() => {
  window.anylinkAvatarReport = (state, message) => {
    window.anylinkAvatarStatus = {state, message};
    const prefix = {loading: 'ANYLINK_AVATAR_STAGE: ', failed: 'ANYLINK_AVATAR_FAILED: ', ready: 'ANYLINK_AVATAR_READY'}[state];
    if (prefix) console[state === 'failed' ? 'error' : 'info'](prefix + (state === 'ready' ? '' : message));
  };
  const report = window.anylinkAvatarReport;
  report('loading', '正在初始化形象页面…');
  const fail = message => { if (window.anylinkAvatarStatus.state === 'loading') report('failed', message); };
  addEventListener('error', event => { if (event.message) fail(event.message); });
  addEventListener('unhandledrejection', event => fail(String(event.reason?.message || event.reason || '脚本执行失败')));
  const load = (file, label) => new Promise((resolve, reject) => {
    report('loading', label);
    const script = document.createElement('script');
    const timer = setTimeout(() => { script.remove(); reject(new Error(file + ' 加载超时')); }, 12000);
    const finish = error => { clearTimeout(timer); script.onload = script.onerror = null; error ? reject(error) : resolve(); };
    script.onload = () => finish();
    script.onerror = () => finish(new Error(file + ' 加载失败'));
    script.src = './' + file;
    document.body.appendChild(script);
  });
  (async () => {
    for (const [file, label] of [
      ['live2dcubismcore.min.js', '加载 Live2D 引擎…'],
      ['pixi.min.js', '加载绘图引擎…'],
      ['cubism4-colors.min.js', '加载模型适配器…'],
      ['avatar.js', '初始化大肥鱼形象…'],
    ]) {
      await load(file, label);
      if (window.anylinkAvatarStatus.state === 'failed') return;
    }
  })().catch(error => fail(error.message || String(error)));
})();
