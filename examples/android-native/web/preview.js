const portrait = document.getElementById('portrait');
const phone = document.getElementById('phone');
const toggleBtn = document.getElementById('mode-toggle');
const labels = {
  idle: '想聊什么，或交给我办点事？',
  listening: '我在听呢，主人请说～',
  thinking: '唔，让本鲸鱼娘想想…',
  working: '正在跨设备帮你处理…',
  speaking: '回复中 · 随时可以打断',
  attention: '这里需要主人确认一下哦',
};
let phase = 'idle';
let reading = false;

function syncAvatar() {
  portrait.contentWindow?.anylinkMobileAvatar?.update({
    phase,
    emotion: phase === 'attention' ? 'apologetic' : phase === 'speaking' ? 'happy' : 'neutral',
    gesture: 'none',
    mini: reading,
    safeTop: 52,
    safeBottom: 0,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  });
}

function change(next) {
  phase = next;
  document.body.dataset.phase = phase;
  document.getElementById('state-label').textContent = labels[phase];
  document.getElementById('voice-button').textContent = ['idle', 'attention'].includes(phase) ? '说话' : '停止';
  for (const button of document.querySelectorAll('.states [data-phase]')) {
    button.classList.toggle('selected', button.dataset.phase === phase);
  }
  syncAvatar();
}

portrait.addEventListener('load', () => syncAvatar());
for (const button of document.querySelectorAll('.states [data-phase]')) {
  button.addEventListener('click', () => change(button.dataset.phase));
}
document.getElementById('voice-button').addEventListener('click', () => change(['idle', 'attention'].includes(phase) ? 'listening' : 'idle'));
document.getElementById('results-button').addEventListener('click', () => { document.getElementById('results').hidden = false; });
document.getElementById('close-results').addEventListener('click', () => { document.getElementById('results').hidden = true; });
toggleBtn.addEventListener('click', () => {
  reading = !reading;
  phone.classList.toggle('reading', reading);
  toggleBtn.textContent = reading ? '陪伴视图 ⌄' : '展开阅读 ⌃';
  syncAvatar();
});
change('idle');
