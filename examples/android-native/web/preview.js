const $ = id => document.getElementById(id);
const portrait = $('portrait'), phone = $('phone');
const sampleText = '你好，主人。文件已经收到了，点开聊天里的预览就能查看。';
const labels = {idle:'在这里，随时听你说',listening:'正在听你说',thinking:'正在准备回复',working:'正在处理任务',speaking:'正在说话 · 点人物可插话',attention:'这里需要你确认一下'};
let phase='idle', reading=false, calling=false, muted=false, speaker=false, level=0, sequence=0, gesture='none';
const samplePlayer=$('speech-sample');
let tick, timer, seconds=0, noticeTimer, audioEpoch=0, sampleEnvelope=[], samplePreparation;
let activeCue, callSequence=0;
function stopCue(){activeCue?.();activeCue=null;}
function playCue(name){
 stopCue();
 return new Promise(resolve=>{
  const player=new Audio('./call-'+name+'.wav');player.volume=.55;
  let done=false;
  const finish=()=>{if(done)return;done=true;clearTimeout(deadline);player.pause();if(activeCue===finish)activeCue=null;resolve();};
  const deadline=setTimeout(finish,1200);activeCue=finish;
  player.addEventListener('ended',finish,{once:true});player.addEventListener('error',finish,{once:true});player.play().catch(finish);
 });
}

function syncAvatar(){
 portrait.contentWindow?.anylinkMobileAvatar?.update({phase,emotion:phase==='speaking'?'happy':phase==='attention'?'curious':'neutral',gesture,sequence:String(sequence),level,
  mini:reading&&!calling,call:calling,safeTop:(calling?124:104)*(window.devicePixelRatio||1),
  safeBottom:Math.max(0,phone.getBoundingClientRect().bottom-(calling?document.querySelector('.call-actions'):document.querySelector('.glass-sheet')).getBoundingClientRect().top)*(window.devicePixelRatio||1),reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches});
}
function change(next){phase=next;document.body.dataset.phase=phase;$('state-label').textContent=labels[phase];syncAvatar();}
function notice(text){$('notice').textContent=text;$('notice').hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('notice').hidden=true,3600);}
function stopSpeech(){
 stopCue();
 audioEpoch++;samplePlayer.pause();clearInterval(tick);tick=null;level=0;gesture='none';sequence++;
 change(calling&&!muted?'listening':'idle');
 if(calling)$('call-status').textContent=muted?'麦克风已静音':'正在听你说';
 $('sample-status').textContent='声音已停止，口型已收起。';
}
function prepareSample(){
 return samplePreparation??=(async()=>{
  const response=await fetch('./preview-speech.mp3');if(!response.ok)throw Error('sample_missing');
  const Offline=window.OfflineAudioContext||window.webkitOfflineAudioContext;
  const decoder=new Offline(1,1,16000);
  const buffer=await decoder.decodeAudioData(await response.arrayBuffer());
  const step=Math.max(1,Math.floor(buffer.sampleRate*.02));
  const channels=Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i));
  const envelope=[];
  for(let start=0;start<buffer.length;start+=step){
   let sum=0,count=0;
   for(const channel of channels)for(let i=start;i<Math.min(start+step,channel.length);i++){sum+=channel[i]*channel[i];count++;}
   envelope.push(Math.max(0,Math.min(1,(Math.sqrt(sum/count)-.008)*5.5)));
  }
  sampleEnvelope=envelope;
 })().catch(error=>{samplePreparation=null;throw error;});
}
samplePlayer.addEventListener('playing',()=>{
 clearInterval(tick);gesture='wave';sequence++;change('speaking');
 if(calling){$('call-status').textContent='正在说话 · 点人物可插话';$('call-caption').textContent=sampleText;}
 $('sample-status').textContent='正在播放：'+sampleText;
 tick=setInterval(()=>{level=sampleEnvelope[Math.floor(samplePlayer.currentTime/.02)]||0;syncAvatar();},30);
});
samplePlayer.addEventListener('ended',()=>{stopSpeech();$('sample-status').textContent='播放结束，口型已收起。';});
samplePlayer.addEventListener('pause',()=>{if(samplePlayer.paused&&phase==='speaking'){clearInterval(tick);level=0;gesture='none';sequence++;change(calling&&!muted?'listening':'idle');}});
async function playSample(){
 stopSpeech();const stamp=audioEpoch;samplePlayer.currentTime=0;
 $('sample-status').textContent='正在准备语音样本…';
 try{const playing=samplePlayer.play();await Promise.all([prepareSample(),playing]);if(stamp!==audioEpoch)return;}
 catch(error){if(stamp!==audioEpoch)return;stopSpeech();$('sample-status').textContent=error.name==='NotAllowedError'?'请点击下方播放器的播放按钮开启音频。':'语音样本未就绪，请先运行 create-preview-audio.mjs。';}
}
prepareSample().catch(()=>{});
async function startCall(){
 const stamp=++callSequence;
 stopSpeech();calling=true;muted=false;seconds=0;phone.classList.add('calling');$('call-screen').hidden=false;
 $('recording').hidden=true;$('call-caption').textContent='可以播放下方语音样本，检查动作和口型。';$('call-status').textContent='正在听你说';$('call-timer').textContent='00:00';
 setMute(false);change('idle');clearInterval(timer);$('call-status').textContent='正在接通…';
 await playCue('start');if(!calling||stamp!==callSequence)return;
 change('listening');$('call-status').textContent='正在听你说';timer=setInterval(()=>{$('call-timer').textContent=String(Math.floor(++seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');},1000);
}
function setMute(value){muted=value;$('mute-button').classList.toggle('selected',muted);$('mute-button').querySelector('small').textContent=muted?'取消静音':'静音';$('mute-button').querySelector('use').setAttribute('href','./icons/sprite.svg#'+(muted?'mic-off':'mic'));if(calling&&phase!=='speaking'){$('call-status').textContent=muted?'麦克风已静音':'正在听你说';change(muted?'idle':'listening');}}
portrait.addEventListener('load',syncAvatar);
$('mode-toggle').addEventListener('click',()=>{reading=!reading;phone.classList.toggle('reading',reading);$('mode-toggle').firstChild.textContent=reading?'陪伴视图':'展开阅读';syncAvatar();});
$('call-button').addEventListener('click',startCall);
$('hangup-button').addEventListener('click',()=>{callSequence++;calling=false;stopSpeech();clearInterval(timer);phone.classList.remove('calling');$('call-screen').hidden=true;playCue('end');notice('通话已结束，口型与动作已停止。');});
$('mute-button').addEventListener('click',()=>setMute(!muted));
$('route-button').addEventListener('click',()=>{speaker=!speaker;$('route-button').classList.toggle('selected',speaker);$('route-button').querySelector('small').textContent=speaker?'外放':'听筒';$('route-button').querySelector('use').setAttribute('href','./icons/sprite.svg#'+(speaker?'speaker':'earpiece'));notice('音频输出按钮演示；实际路由需在 Android 上验证。');});
$('call-stage').addEventListener('click',()=>{stopSpeech();if(calling)$('call-caption').textContent='播报已停止，可以继续说话。';});
$('voice-button').addEventListener('click',()=>{$('recording').hidden=!$('recording').hidden;change($('recording').hidden?'idle':'listening');});
for(const id of ['finish-recording','cancel-recording'])$(id).addEventListener('click',()=>{$('recording').hidden=true;change('idle');if(id==='finish-recording')notice('这是语音输入布局演示；系统识别需在 Android 上验证。');});
$('file-preview').addEventListener('click',()=>$('file-dialog').showModal());$('close-file').addEventListener('click',()=>$('file-dialog').close());
for(const id of ['file-open','file-share','attachment-button'])$(id).addEventListener('click',()=>notice('这里是演示文件；原生 App 使用系统文件选择、打开与分享。'));
$('results-button').addEventListener('click',()=>notice('收到的文件会在聊天中保留，重启后可恢复。'));
function updateOpacity(){const value=Number($('overlay-transparency').value);$('opacity-value').textContent=value+'%';$('floating-example').style.opacity=String(1-value/100);try{localStorage.setItem('anylink-preview-overlay-transparency',String(value));}catch{}}
try{$('overlay-transparency').value=String(Math.max(0,Math.min(80,Number(localStorage.getItem('anylink-preview-overlay-transparency'))||0)));}catch{}
updateOpacity();$('overlay-transparency').addEventListener('input',updateOpacity);
$('floating-avatar').addEventListener('error',()=>{$('floating-avatar').hidden=true;});
$('settings-button').addEventListener('click',()=>$('settings-dialog').showModal());
$('close-settings').addEventListener('click',()=>$('settings-dialog').close());
$('composer').addEventListener('submit',event=>{event.preventDefault();if(!$('draft').value.trim())return;const bubble=document.createElement('div');bubble.className='bubble user';bubble.textContent=$('draft').value;$('chat-feed').appendChild(bubble);$('draft').value='';bubble.scrollIntoView({block:'nearest'});notice('本地对话布局演示，未发送到服务器。');});
$('play-sample').addEventListener('click',playSample);
for(const button of document.querySelectorAll('.preview-controls [data-phase]'))button.addEventListener('click',()=>{stopSpeech();change(button.dataset.phase);});
new ResizeObserver(syncAvatar).observe(phone);
window.addEventListener('pagehide',()=>{stopSpeech();clearInterval(timer);});
change('idle');
