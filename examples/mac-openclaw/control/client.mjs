import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const exec=promisify(execFile);
export const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
export const controlDirectory=path.join(projectRoot,'data/mac/control');
export function validateControlRoot(root){
  if(typeof root!=='string'||!path.isAbsolute(root)||!fs.existsSync(path.join(root,'examples/mac-openclaw/control/versions.json')))throw new Error('EXPLICIT_PROJECT_ROOT_REQUIRED');
  return fs.realpathSync(root);
}
export const bridgeSocket=path.join(os.homedir(),'Library/Application Support/Peekaboo/bridge.sock');
export function enabled(root=projectRoot){try{return JSON.parse(fs.readFileSync(path.join(root,'data/mac/control/control.json'),'utf8')).enabled===true;}catch{return false;}}

export async function peek(args,{signal,timeout=20000,root=projectRoot}={}){
  const runtime=JSON.parse(fs.readFileSync(path.join(root,'data/mac/control/runtime.json'),'utf8'));
  const env={...process.env,PEEKABOO_BRIDGE_SOCKET:bridgeSocket};
  for(const name of ['DEEPSEEK_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','ANYLINK_DEVICE_TOKEN'])delete env[name];
  let stdout;
  try{({stdout}=await exec(runtime.binary,[...args,'--bridge-socket',bridgeSocket,'--log-level','error','--json'],{env,signal,timeout,maxBuffer:8*1024*1024}));}
  catch(error){
    if(error.stdout){try{return JSON.parse(error.stdout);}catch{}}
    return {success:false,error:{code:signal?.aborted?'ACTION_INTERRUPTED':'CONTROL_TRANSPORT_UNCONFIRMED',message:'控制组件未确认结果。请重新观察，不要自动重放输入。'}};
  }
  try{return JSON.parse(stdout);}catch{return {success:false,error:{code:'INVALID_CONTROL_RESULT',message:'控制结果未确认，请重新观察。'}};}
}

export async function controlStatus(root=projectRoot,query=peek){
  if(!enabled(root))return {enabled:false,ready:false,summary:'电脑控制未启用。点击“启用电脑控制”后，再在系统设置中为 Peekaboo 授权。'};
  try{
    // Upstream's diagnostic handshake has a fixed 1s budget. Only this read-only
    // probe may retry; action calls are never replayed by the transport.
    let bridge;
    for(let attempt=0;attempt<5;attempt++){
      bridge=await query(['bridge','status'],{root});
      if(bridge.success||bridge.error?.code!=='BRIDGE_UNAVAILABLE'||!/diagnostic handshake timed out/.test(bridge.error.message??''))break;
    }
    const selected=bridge.data?.selected;
    if(!bridge.success||!selected||selected.source==='local')return {enabled:true,ready:false,summary:bridge.error?.code==='BRIDGE_UNAVAILABLE'?'控制主机握手暂未完成，尚未派发操作。请稍后刷新；持续失败时在本机重新打开 Peekaboo。':'已启用，等待 Peekaboo 本机控制主机启动。请定位授权应用并打开。'};
    const socket=selected.socketPath??selected.socket_path;
    if(socket!==bridgeSocket)return {enabled:true,ready:false,summary:'控制主机与配置不符，已拒绝自动切换。请重启 AnyLink 的 Peekaboo 组件。'};
    const lock=JSON.parse(fs.readFileSync(path.join(root,'examples/mac-openclaw/control/versions.json'),'utf8'));
    const identity=selected.handshake?.hostIdentity;
    if(identity?.bundleIdentifier!=='boo.peekaboo.mac'||identity.bundleShortVersion!==lock.version||identity.sourceCommit!==lock.sourceCommit)return {enabled:true,ready:false,summary:'控制组件版本与固定版本不符，已停止使用。请重新安装当前版本的 AnyLink.app。'};
    const response=await query(['permissions','status'],{root});
    const permissions=response.data?.permissions??[];
    const granted=p=>p.isGranted===true||p.granted===true||p.status==='granted';
    const screen=permissions.some(p=>/screen|屏幕/i.test(p.name??'')&&granted(p));
    const accessibility=permissions.some(p=>/accessibility|辅助功能/i.test(p.name??'')&&granted(p));
    const ready=response.success===true&&response.data?.source==='bridge'&&screen&&accessibility&&permissions.filter(p=>p.isRequired===true||p.required===true).every(granted);
    return {enabled:true,ready,permissions:permissions.map(p=>({name:p.name,granted:granted(p)})),summary:ready?'电脑控制已就绪。可以在聊天中操作指定软件；随时可停止控制。':`等待 macOS 授权：${[!accessibility?'辅助功能':null,!screen?'屏幕与系统音频录制':null].filter(Boolean).join('、')||'事件输入权限'}。请为 Peekaboo 授权后刷新状态。`};
  }catch{return {enabled:true,ready:false,summary:'控制组件尚未安装或未响应，请检查本机安装。'};}
}
