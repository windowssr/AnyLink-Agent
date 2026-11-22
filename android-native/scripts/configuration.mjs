import path from 'node:path';
export const previewAgent='anylink-android-preview';
export function configuredPreview(original,root) {
  const c=structuredClone(original);
  if(c.gateway?.bind!=='loopback'||c.gateway?.port!==18791)throw new Error('Unexpected local Gateway profile');
  if(!c.agents?.entries||!c.plugins?.entries?.['anylink-memory'])throw new Error('Configure the existing Mac profile first');
  const workspace=path.join(root,'data/android-native/workspace');
  c.agents.entries[previewAgent]={...c.agents.entries[previewAgent],name:'大肥鱼 · Android 开发预览',workspace,
    identity:{name:'大肥鱼',avatar:'avatars/dafeiyu.png'},
    tools:{allow:['anylink_memory_search','anylink_memory_save','anylink_memory_update','anylink_memory_delete','anylink_mac_search_files','anylink_companion_expression','nodes']}};
  const memory=c.plugins.entries['anylink-memory'];
  memory.config={...memory.config,deviceConnections:{...memory.config.deviceConnections,[previewAgent]:{connectionFile:path.join(root,'secrets/android-preview-connection.json'),label:'Android 开发预览（未绑定真机）',platform:'android'}}};
  c.plugins.allow=[...new Set([...c.plugins.allow,'microsoft'])];
  c.plugins.entries.microsoft={...c.plugins.entries.microsoft,enabled:true};
  const voice={speakerVoice:'zh-CN-XiaoyiNeural',lang:'zh-CN',rate:'+8%',pitch:'+3Hz',outputFormat:'audio-24khz-48kbitrate-mono-mp3',timeoutMs:15000};
  c.tts={...c.tts,auto:c.tts?.auto??'off',provider:'microsoft',providers:{...c.tts?.providers,microsoft:{...c.tts?.providers?.microsoft,...voice}}};
  c.talk={...c.talk,provider:'microsoft',providers:{...c.talk?.providers,microsoft:{...c.talk?.providers?.microsoft,speakerVoiceId:'zh-CN-XiaoyiNeural',languageCode:'zh-CN',rate:'+8%',pitch:'+3Hz'}},speechLocale:'zh-CN',silenceTimeoutMs:850,interruptOnSpeech:true,realtime:{...c.talk?.realtime,mode:'stt-tts'}};
  // Select Talk speech explicitly: this pinned Gateway refuses talk.speak when
  // only the shared TTS provider is configured. No realtime model account is used.
  return c;
}
