import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {classify,cleanSpeech,emotions,gestures} from '../behavior.mjs';
import {controlActions,sendControl,allowedControl,controlChannel} from '../control.mjs';

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
    const channel=controlChannel(ctx);if(channel&&!['webchat','web','openai-http'].includes(channel))return false;
    const record={id:randomUUID(),type,created_at:now(),expires_at:now()+120000,agentId:ctx.agentId??'main',sessionId:ctx.sessionId??'',sessionKey:ctx.sessionKey??'',runId:ctx.runId??'',...extra};
    fs.mkdirSync(outbox,{recursive:true,mode:0o700});
    const file=path.join(outbox,`${now()}-${record.id}.json`);
    fs.writeFileSync(file+'.tmp',JSON.stringify(record),{mode:0o600});fs.renameSync(file+'.tmp',file);return true;
  }
  return {emit,prune};
}

export function projectToolResult(event){
  const failed=!!event.error||event.result?.isError===true;
  const projection={toolName:event.toolName,toolCallId:event.toolCallId??'',failed};
  // Expose only this tool's typed metadata. Shell output, file contents and
  // arbitrary tool arguments never enter the avatar projection directory.
  if(event.toolName!=='anylink_mac_search_files'||failed)return projection;
  const result=event.result?.details;
  if(result?.read_only!==true||result?.name_only!==true||!Array.isArray(result.matches))return projection;
  projection.search={query:String(result.query??'').slice(0,120),read_only:true,name_only:true,partial:result.partial===true,matches:result.matches.slice(0,30).filter(file=>typeof file.name==='string'&&typeof file.path==='string'&&path.isAbsolute(file.path)&&!file.path.includes('\0')).map(file=>({name:file.name.slice(0,255),path:file.path.slice(0,2048)}))};
  // Keep each projection within the native reader's bounded envelope.
  while(Buffer.byteLength(JSON.stringify(projection))>18000&&projection.search.matches.length){projection.search.matches.pop();projection.search.partial=true;}
  return projection;
}

export default {
  id:'anylink-companion',name:'AnyLink Desktop Companion',
  register(api){
    const root=api.pluginConfig?.projectRoot;if(!root)throw new Error('Companion projectRoot required');
    const persona=fs.readFileSync(path.join(root,'examples/mac-openclaw/companion/persona.md'),'utf8');
    const mobilePersonaFile=path.join(root,'examples/android-native/persona.md');
    const mobilePersona=fs.existsSync(mobilePersonaFile)?fs.readFileSync(mobilePersonaFile,'utf8'):'';
    const mobile=ctx=>/^anylink-android(?:-|$)/.test(ctx.agentId??'');
    const bridge=createBridge(root),turns=new Map();
    api.on('before_prompt_build',(event,ctx)=>{
      const prompt=event.currentUserMessage??event.prompt??'';
      if(ctx.runId){turns.set(ctx.runId,{prompt:prompt.slice(0,1600),text:'',explicit:false});if(turns.size>80)turns.delete(turns.keys().next().value);}
      bridge.emit('user',ctx,{...classify(prompt)});
      const desktop=ctx.sessionKey?.startsWith('agent:main:anylink:desktop:')?'\n当前通过桌面人物身边的轻量交互接待主人。简短自然地回复；找本机文件优先使用 anylink_mac_search_files，真实结构化结果会显示在人物身边。不要为了接待而打开完整聊天窗口。遇到失败或审批要明确说明，不能用表演代替执行。':'';
      return {appendSystemContext:mobile(ctx)?mobilePersona:persona+desktop,...(ctx.agentId==='companion'?{toolsAllow:['anylink_companion_expression','anylink_companion_control']}: {})};
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
      if(ctx.agentId==='companion'&&event.toolName!=='anylink_companion_expression'&&!(event.toolName==='anylink_companion_control'&&allowedControl(ctx,event.params??{})))return {block:true,blockReason:'主动陪伴只能表达、查看自己的状态和散步，不能更改主人的偏好或执行设备任务。'};
      if(ctx.sessionKey?.startsWith('agent:main:anylink:desktop:'))bridge.emit('tool_start',ctx,{toolName:event.toolName,toolCallId:event.toolCallId??ctx.toolCallId??''});
    });
    api.on('after_tool_call',(event,ctx)=>{
      if(ctx.sessionKey?.startsWith('agent:main:anylink:desktop:'))bridge.emit('tool_result',ctx,projectToolResult({...event,toolCallId:event.toolCallId??ctx.toolCallId}));
    });
    api.registerTool(ctx=>({
      name:'anylink_companion_expression',label:'表达桌面伙伴情绪',
      description:'让本机桌面伙伴显示一次表情和小动作。用于明显的开心、安慰、好奇、道歉；无需每句调用。只改变形象，不操作电脑。',
      parameters:{type:'object',properties:{emotion:{type:'string',enum:emotions},gesture:{type:'string',enum:gestures}},required:['emotion','gesture'],additionalProperties:false},
      async execute(_id,params){
        if(!emotions.includes(params.emotion)||!gestures.includes(params.gesture))throw new Error('Unsupported companion expression');
        const turn=turns.get(ctx.runId);if(turn){turn.explicit=true;turn.expression={emotion:params.emotion,gesture:params.gesture};}
        if(mobile(ctx))return {content:[{type:'text',text:JSON.stringify({requested:true,presentation_target:'android-client',render_confirmed:false})}]};
        const delivered=bridge.emit('expression',ctx,{emotion:params.emotion,gesture:params.gesture});
        return {content:[{type:'text',text:JSON.stringify({queued:delivered,desktop_only:true})}]};
      },
    }),{names:['anylink_companion_expression'],workspaceAccess:false});
    api.registerTool(ctx=>({
      name:'anylink_companion_control',label:'管理自己的桌面形象',
      description:'通过本机应用管理大肥鱼：查看状态、散步、摸头回应、大小、位置、显隐、重载、安静时长、主动聊天与语音偏好、打开聊天或语音及角色来源。主动聊天、自由行走、语音默认开启；只有主人明确要求时才关闭。设置要实际调用工具并依据回执回复。walk 可能排到当前回复播完后；未知结果不可自动重试。',
      parameters:{type:'object',properties:{action:{type:'string',enum:controlActions},roaming:{type:'boolean'},proactive:{type:'boolean'},read_aloud:{type:'boolean'},minutes:{type:'integer',minimum:0,maximum:720,description:'quiet 的分钟数；0 恢复'},scale:{type:'number',enum:[0.8,1,1.25],description:'0.8=小号，1=标准大小，1.25=大号；恢复标准大小时必须使用1'}},required:['action'],additionalProperties:false},
      async execute(id,parameters){
        const result=await sendControl(root,ctx,id,parameters);
        return {content:[{type:'text',text:JSON.stringify(result)}]};
      },
    }),{names:['anylink_companion_control'],workspaceAccess:false});
  },
};
