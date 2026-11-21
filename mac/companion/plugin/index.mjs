import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {classify,cleanSpeech,emotions,gestures} from '../behavior.mjs';

export function createBridge(root,now=()=>Date.now()){
  const folder=path.join(root,'data/mac/companion'),outbox=path.join(folder,'events');
  function prune(){
    if(!fs.existsSync(outbox))return;
    const files=fs.readdirSync(outbox).filter(name=>/^[\d]+-[a-f0-9-]+\.json$/.test(name)).sort();
    for(const [index,name] of files.entries())if(Number(name.split('-')[0])<now()-120000||index<files.length-64)fs.rmSync(path.join(outbox,name),{force:true});
  }
  function emit(type,ctx,extra={}){
    prune();
    let lease;try{lease=JSON.parse(fs.readFileSync(path.join(folder,'presence.json'),'utf8'));}catch{return false;}
    if(lease.enabled!==true||!Number.isFinite(lease.expires_at)||lease.expires_at<now()||lease.expires_at>now()+90000)return false;
    if(!['main','companion'].includes(ctx.agentId??'main'))return false;
    if(ctx.channel&&!['webchat','web','openai-http'].includes(ctx.channel))return false;
    const record={id:randomUUID(),type,created_at:now(),expires_at:now()+120000,agentId:ctx.agentId??'main',sessionId:ctx.sessionId??'',sessionKey:ctx.sessionKey??'',runId:ctx.runId??'',...extra};
    fs.mkdirSync(outbox,{recursive:true,mode:0o700});
    const file=path.join(outbox,`${now()}-${record.id}.json`);
    fs.writeFileSync(file+'.tmp',JSON.stringify(record),{mode:0o600});fs.renameSync(file+'.tmp',file);return true;
  }
  return {emit,prune};
}

export default {
  id:'anylink-companion',name:'AnyLink Desktop Companion',
  register(api){
    const root=api.pluginConfig?.projectRoot;if(!root)throw new Error('Companion projectRoot required');
    const persona=fs.readFileSync(path.join(root,'mac/companion/persona.md'),'utf8');
    const bridge=createBridge(root),turns=new Map();
    api.on('before_prompt_build',(event,ctx)=>{
      const prompt=event.currentUserMessage??event.prompt??'';
      if(ctx.runId){turns.set(ctx.runId,{prompt:prompt.slice(0,1600),text:'',explicit:false});if(turns.size>80)turns.delete(turns.keys().next().value);}
      bridge.emit('user',ctx,{...classify(prompt)});
      return {appendSystemContext:persona,...(ctx.agentId==='companion'?{toolsAllow:['anylink_companion_expression']}: {})};
    });
    api.on('llm_output',(event,ctx)=>{
      const turn=turns.get(ctx.runId??event.runId);if(turn)turn.text=(event.assistantTexts??[]).filter(text=>typeof text==='string').join('\n').slice(-6000);
    });
    api.on('agent_end',(event,ctx)=>{
      const key=ctx.runId??event.runId,turn=turns.get(key);turns.delete(key);
      if(!event.success){bridge.emit('error',ctx,{emotion:'apologetic',gesture:'nod'});return;}
      const messages=event.messages??[];
      const last=[...messages].reverse().find(message=>message?.role==='assistant'&&Array.isArray(message.content)&&message.content.some(part=>part.type==='text'));
      const raw=last?.content.filter(part=>part.type==='text').map(part=>part.text??'').join('\n')||turn?.text||'';
      const text=cleanSpeech(raw);if(!text)return;
      bridge.emit('reply',ctx,{text,caption:text.slice(0,100),...(turn?.expression??classify((turn?.prompt??'')+'\n'+text)),explicit_expression:turn?.explicit??false});
    });
    api.on('before_tool_call',(event,ctx)=>{
      if(ctx.agentId==='companion'&&event.toolName!=='anylink_companion_expression')return {block:true,blockReason:'主动陪伴会话只允许表情动作；任务请在正常助理会话提出。'};
    });
    api.registerTool(ctx=>({
      name:'anylink_companion_expression',label:'表达桌面伙伴情绪',
      description:'让本机桌面伙伴显示一次表情和小动作。用于明显的开心、安慰、好奇、道歉；无需每句调用。只改变形象，不操作电脑。',
      parameters:{type:'object',properties:{emotion:{type:'string',enum:emotions},gesture:{type:'string',enum:gestures}},required:['emotion','gesture'],additionalProperties:false},
      async execute(_id,params){
        if(!emotions.includes(params.emotion)||!gestures.includes(params.gesture))throw new Error('Unsupported companion expression');
        const turn=turns.get(ctx.runId);if(turn){turn.explicit=true;turn.expression={emotion:params.emotion,gesture:params.gesture};}
        const delivered=bridge.emit('expression',ctx,{emotion:params.emotion,gesture:params.gesture});
        return {content:[{type:'text',text:JSON.stringify({queued:delivered,desktop_only:true})}]};
      },
    }),{names:['anylink_companion_expression'],workspaceAccess:false});
  },
};
