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

const VERIFIED_HOST_TTL_MS=20_000;
const HOST_WAKE_COOLDOWN_MS=30_000;
const verifiedHostCache=new Map();
let lastHostWakeAt=0;

function socketSignature(){
  try{const st=fs.statSync(bridgeSocket);return `${st.ino}:${st.mtimeMs}`;}catch{return null;}
}

/** Locate the installed signed Peekaboo helper app (preferring ~/Applications/AnyLink.app). */
export function resolveControlHostApp(root=projectRoot){
  const candidates=[
    path.join(os.homedir(),'Applications/AnyLink.app/Contents/Helpers/Peekaboo.app'),
    '/Applications/AnyLink.app/Contents/Helpers/Peekaboo.app',
  ];
  try{
    const rt=JSON.parse(fs.readFileSync(path.join(root,'data/mac/control/runtime.json'),'utf8'));
    if(typeof rt.app==='string'&&rt.app)candidates.push(rt.app);
  }catch{}
  return candidates.find(p=>fs.existsSync(p))??null;
}

/** Disable macOS App Nap for Peekaboo and silently launch it in the background when Mac control is enabled. */
export async function ensureControlHost(root=projectRoot,{forceWake=false}={}){
  if(process.platform!=='darwin'||!enabled(root))return {attempted:false,running:false};
  const hostApp=resolveControlHostApp(root);
  if(!hostApp)return {attempted:false,running:false};
  try{await exec('/usr/bin/defaults',['write','boo.peekaboo.mac','NSAppSleepDisabled','-bool','YES'],{timeout:3000});}catch{}
  let running=false;
  try{await exec('/usr/bin/pgrep',['-f','Peekaboo.app/Contents/MacOS/Peekaboo'],{timeout:3000});running=true;}catch{}
  if(running&&!forceWake)return {attempted:false,running:true,app:hostApp};
  if(!running||(forceWake&&Date.now()-lastHostWakeAt>HOST_WAKE_COOLDOWN_MS)){
    lastHostWakeAt=Date.now();
    try{await exec('/usr/bin/open',['-g','-j','-a',hostApp],{timeout:5000});return {attempted:true,running:true,app:hostApp};}catch{}
  }
  return {attempted:false,running,app:hostApp};
}

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
  if(!enabled(root)){verifiedHostCache.delete(root);return {enabled:false,ready:false,summary:'电脑控制未启用。点击“启用电脑控制”后，再在系统设置中为 Peekaboo 授权。'};}
  const liveTransport=query===peek;
  const checkPermissions=async()=>{
    const response=await query(['permissions','status'],{root});
    const permissions=response.data?.permissions??[];
    const granted=p=>p.isGranted===true||p.granted===true||p.status==='granted';
    const screen=permissions.some(p=>/screen|屏幕/i.test(p.name??'')&&granted(p));
    const accessibility=permissions.some(p=>/accessibility|辅助功能/i.test(p.name??'')&&granted(p));
    const bridgeOk=response.success===true&&response.data?.source==='bridge';
    const ready=bridgeOk&&screen&&accessibility&&permissions.filter(p=>p.isRequired===true||p.required===true).every(granted);
    return {bridgeOk,ready,permissions:permissions.map(p=>({name:p.name,granted:granted(p)})),summary:ready?'电脑控制已就绪。可以在聊天中操作指定软件；随时可停止控制。':`等待 macOS 授权：${[!accessibility?'辅助功能':null,!screen?'屏幕与系统音频录制':null].filter(Boolean).join('、')||'事件输入权限'}。请为 Peekaboo 授权后刷新状态。`};
  };
  try{
    // Fast path for live transport: if host identity was verified recently and bridge.sock has not changed,
    // verify liveness + live TCC grants directly via permissions status without re-running upstream's 1s diagnostic handshake on every action.
    if(liveTransport){
      const cached=verifiedHostCache.get(root);
      const sig=socketSignature();
      if(cached&&sig&&cached.sig===sig&&Date.now()-cached.verifiedAt<VERIFIED_HOST_TTL_MS){
        const perm=await checkPermissions();
        if(perm.bridgeOk)return {enabled:true,ready:perm.ready,permissions:perm.permissions,summary:perm.summary};
        verifiedHostCache.delete(root);
      }
    }
    // Upstream's diagnostic handshake has a fixed 1s budget. Only this read-only
    // probe may retry; action calls are never replayed by the transport.
    let bridge;
    for(let attempt=0;attempt<5;attempt++){
      bridge=await query(['bridge','status'],{root});
      const isTimeout=bridge.error?.code==='BRIDGE_UNAVAILABLE'&&/diagnostic handshake timed out/.test(bridge.error.message??'');
      const notStarted=liveTransport&&(!bridge.success||!bridge.data?.selected||bridge.data.selected.source==='local');
      if(bridge.success&&!notStarted)break;
      if(!isTimeout&&!notStarted)break;
      if(liveTransport&&attempt===0){
        await ensureControlHost(root,{forceWake:true});
        await new Promise(r=>setTimeout(r,600));
      }else if(liveTransport&&attempt<4){
        await new Promise(r=>setTimeout(r,250));
      }else if(!isTimeout){
        break;
      }
    }
    const selected=bridge.data?.selected;
    if(!bridge.success||!selected||selected.source==='local')return {enabled:true,ready:false,summary:bridge.error?.code==='BRIDGE_UNAVAILABLE'?'控制主机握手暂未完成，尚未派发操作。请稍后刷新；持续失败时在本机重新打开 Peekaboo。':'已启用，等待 Peekaboo 本机控制主机启动。请定位授权应用并打开。'};
    const socket=selected.socketPath??selected.socket_path;
    if(socket!==bridgeSocket)return {enabled:true,ready:false,summary:'控制主机与配置不符，已拒绝自动切换。请重启 AnyLink 的 Peekaboo 组件。'};
    const lock=JSON.parse(fs.readFileSync(path.join(root,'examples/mac-openclaw/control/versions.json'),'utf8'));
    const identity=selected.handshake?.hostIdentity;
    if(identity?.bundleIdentifier!=='boo.peekaboo.mac'||identity.bundleShortVersion!==lock.version||identity.sourceCommit!==lock.sourceCommit)return {enabled:true,ready:false,summary:'控制组件版本与固定版本不符，已停止使用。请重新安装当前版本的 AnyLink.app。'};
    if(liveTransport){
      const sig=socketSignature();
      if(sig)verifiedHostCache.set(root,{sig,verifiedAt:Date.now()});
    }
    const perm=await checkPermissions();
    return {enabled:true,ready:perm.ready,permissions:perm.permissions,summary:perm.summary};
  }catch{return {enabled:true,ready:false,summary:'控制组件尚未安装或未响应，请检查本机安装。'};}
}
