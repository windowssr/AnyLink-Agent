export const emotions=['neutral','happy','excited','comfort','curious','apologetic'];
export const gestures=['none','wave','point','nod'];
export function classify(text=''){
  if(/难过|伤心|累了|疲惫|焦虑|压力|失落|不开心|心情不好|sad|exhausted/i.test(text))return {emotion:'comfort',gesture:'nod'};
  if(/抱歉|对不起|出错|没能|失败|sorry|apolog/i.test(text))return {emotion:'apologetic',gesture:'nod'};
  if(/恭喜|太棒|好消息|成功了|考过|通过了|开心|庆祝|congrat|celebrat/i.test(text))return {emotion:'excited',gesture:'wave'};
  if(/谢谢|感谢|喜欢你|陪着|你好|早上好|晚上好|thank|hello/i.test(text))return {emotion:'happy',gesture:'wave'};
  if(/为什么|怎么|原理|好奇|解释|看看|why|how/i.test(text))return {emotion:'curious',gesture:'point'};
  return {emotion:'neutral',gesture:'none'};
}
export function cleanSpeech(text='',limit=1400){
  return text.replace(/```[\s\S]*?(?:```|$)/g,'').replace(/<think>[\s\S]*?<\/think>/gi,'')
    .replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')
    .replace(/https?:\/\/\S+/g,'').replace(/[#*_>`|]/g,'').replace(/\s+/g,' ').trim().slice(0,limit);
}
