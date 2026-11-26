const portrait = document.getElementById('portrait');
const labels = {idle:'想聊什么，或想让我做点什么？',listening:'我在听，你说。',thinking:'让我想一想…',working:'正在帮你处理…',speaking:'正在回复 · 可以打断',attention:'这件事需要你看看'};
let phase = 'idle';
function change(next) {
  phase = next; document.body.dataset.phase = phase;
  document.getElementById('state-label').textContent = labels[phase];
  document.getElementById('voice-button').textContent = ['idle','attention'].includes(phase) ? '演示倾听' : '结束演示';
  for (const button of document.querySelectorAll('.states [data-phase]')) button.classList.toggle('selected',button.dataset.phase === phase);
  portrait.contentWindow?.anylinkMobileAvatar?.update({phase,emotion:phase==='attention'?'apologetic':'neutral',gesture:'none',reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches});
}
portrait.addEventListener('load',()=>change(phase));
for(const button of document.querySelectorAll('.states [data-phase]'))button.addEventListener('click',()=>change(button.dataset.phase));
document.getElementById('voice-button').addEventListener('click',()=>change(['idle','attention'].includes(phase)?'listening':'idle'));
document.getElementById('results-button').addEventListener('click',()=>document.getElementById('results').hidden=false);
document.getElementById('close-results').addEventListener('click',()=>document.getElementById('results').hidden=true);
document.getElementById('text-button').addEventListener('click',()=>{document.getElementById('text-panel').hidden=false;document.querySelector('input').focus();});
document.getElementById('close-text').addEventListener('click',()=>document.getElementById('text-panel').hidden=true);
change('idle');
