import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import './style.css';

type Device={id:string;name:string;platform:'macos'|'android'|'other';executor_connected:false};
type Memory={id:string;title:string;content:string;scope:'global'|'device';applicable_device_id:string|null;device_name?:string;revision:number;source_kind:string;updated_at:string};
type Task={id:string;goal:string;status:'waiting_device'|'cancelled';origin_name:string|null;target_name:string;created_at:string};
type Conversation={id:string;title:string};
type RequestRow={id:string;message:string;state:string;response_text:string;error_code?:string;tool_rounds:number;created_at:string};
type Page='chat'|'memories'|'devices'|'tasks';
const pages:Page[]=['chat','memories','devices','tasks'];
const names={chat:'对话',memories:'记忆',devices:'设备',tasks:'任务'};
const subtitles={chat:'把想法接起来，把事情记下来。',memories:'重要的事，有来处，也可以更正。',devices:'不同的设备，同一个助理。',tasks:'每件事都有明确的去向。'};
const platformNames={macos:'Mac',android:'Android',other:'其他设备'};
const requestNames:Record<string,string>={queued:'已保存，等待回复',submitted:'正在思考',responding:'正在回复',completed:'已完成',submission_unknown:'结果待核对',failed:'暂未完成'};
const active=(r:RequestRow)=>['queued','submitted','responding'].includes(r.state);
const date=(value:string)=>new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});

class HttpError extends Error {constructor(public status:number,message:string){super(message);}}
async function api<T=any>(path:string,method='GET',body?:unknown,headers:Record<string,string>={}):Promise<T> {
  const r=await fetch(path,{method,credentials:'same-origin',headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(method!=='GET'?{'Idempotency-Key':crypto.randomUUID()}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await r.json();if(!r.ok)throw new HttpError(r.status,data.error?.message??'请求未完成');return data;
}
function Icon({name,size=20}:{name:string;size?:number}){
  const paths:Record<string,string>={chat:'M4 4h16v12H9l-5 4V4Z',memories:'M5 3h12l3 3v15H5V3Zm3 5h8M8 12h8M8 16h5',devices:'M3 4h18v12H3V4Zm6 16h6M12 16v4',tasks:'M8 3h8v4H8V3ZM6 5H4v16h16V5h-2M8 12h8M8 16h5',plus:'M12 5v14M5 12h14',arrow:'m12 5 7 7-7 7M5 12h14',logout:'M9 4H4v16h5M14 8l4 4-4 4M8 12h10',link:'m9 15 6-6M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0'};
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]??paths.link}/></svg>;
}
function Brand(){return <div className="brand"><span className="brand-mark"><Icon name="link" size={23}/></span><span>AnyLink<span className="brand-dot">.</span></span></div>;}

function App(){
  const [signedIn,setSignedIn]=useState<boolean|null>(null),[token,setToken]=useState(''),[page,setPage]=useState<Page>('chat');
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[online,setOnline]=useState(false);
  const [devices,setDevices]=useState<Device[]>([]),[memories,setMemories]=useState<Memory[]>([]),[tasks,setTasks]=useState<Task[]>([]),[conversations,setConversations]=useState<Conversation[]>([]);
  const [conversationId,setConversationId]=useState(''),[requests,setRequests]=useState<RequestRow[]>([]),[message,setMessage]=useState(''),[origin,setOrigin]=useState(''),[target,setTarget]=useState(''),[sending,setSending]=useState(false),[activity,setActivity]=useState('');
  const [memoryScope,setMemoryScope]=useState('all'),[memoryDevice,setMemoryDevice]=useState(''),[search,setSearch]=useState('');
  const [modal,setModal]=useState<'memory'|'device'|'task'|'history'|null>(null),[editing,setEditing]=useState<Memory|null>(null),[history,setHistory]=useState<any[]>([]);
  const [memoryForm,setMemoryForm]=useState({title:'',content:'',scope:'global',applicable_device_id:''});
  const [deviceForm,setDeviceForm]=useState({name:'',platform:'macos'}),[taskForm,setTaskForm]=useState({goal:'',target_device_id:'',origin_device_id:''});
  const source=useRef<EventSource|null>(null),watched=useRef(''),bottom=useRef<HTMLDivElement>(null),currentConversation=useRef('');

  async function refresh(){
    const [d,m,t,c]=await Promise.all([api('/v1/devices'),api('/v1/memories'),api('/v1/tasks'),api('/v1/conversations')]);
    setDevices(d.items);setMemories(m.items);setTasks(t.items);setConversations(c.items);
    return c.items as Conversation[];
  }
  function watch(id:string){
    if(watched.current===id&&source.current?.readyState!==EventSource.CLOSED)return;
    source.current?.close();watched.current=id;
    const es=new EventSource(`/v1/requests/${id}/events`);source.current=es;
    es.onmessage=e=>{
      const event=JSON.parse(e.data);
      setRequests(rows=>rows.map(row=>row.id!==id?row:{...row,...(event.type==='snapshot'?event:{}),...(event.type==='delta'?{response_text:row.response_text+event.text,state:'responding'}:{}),...(event.type==='state'?{state:event.state}:{}),...(event.type==='final'?{state:event.state,response_text:event.text,error_code:event.error_code}:{})}));
      if(event.type==='tool')setActivity(event.name.includes('memory')?'正在整理记忆':'正在处理任务信息');
      if(event.type==='final'||(event.type==='snapshot'&&!['queued','submitted','responding'].includes(event.state))){es.close();watched.current='';setActivity('');void refresh().catch(()=>{});}
    };
    es.onerror=()=>{setActivity('正在恢复回复连接…');};
  }
  async function loadConversation(id:string){
    const c=await api(`/v1/conversations/${id}`);
    if(currentConversation.current!==id)return;
    setRequests(c.requests);const last=c.requests.at(-1);if(last&&active(last))watch(last.id);
  }
  useEffect(()=>{void api('/v1/status').then(async()=>{setSignedIn(true);const c=await refresh();if(c.length)setConversationId(c[0].id);}).catch(e=>{if(!(e instanceof HttpError&&e.status===401))setError('暂时无法连接服务，请检查 SSH 隧道。');setSignedIn(false);});},[]);
  useEffect(()=>{if(!signedIn)return;const check=()=>void fetch('/readyz').then(r=>setOnline(r.ok)).catch(()=>setOnline(false));check();const timer=setInterval(check,30000);return()=>clearInterval(timer);},[signedIn]);
  useEffect(()=>{currentConversation.current=conversationId;source.current?.close();watched.current='';setRequests([]);setActivity('');if(conversationId)void loadConversation(conversationId).catch(e=>setError(e.message));return()=>{source.current?.close();watched.current='';};},[conversationId]);
  useEffect(()=>{bottom.current?.scrollIntoView({behavior:'smooth',block:'end'});},[requests.at(-1)?.response_text,requests.length]);
  const run=async(fn:()=>Promise<void>)=>{setBusy(true);setError('');try{await fn();}catch(e){setError((e as Error).message);if(e instanceof HttpError&&e.status===401)setSignedIn(false);}finally{setBusy(false);}};
  const logout=()=>void run(async()=>{source.current?.close();await api('/v1/auth/logout','POST',{});setSignedIn(false);});
  async function login(e:FormEvent){e.preventDefault();await run(async()=>{await api('/v1/auth/login','POST',{token});setToken('');setSignedIn(true);const c=await refresh();if(c.length)setConversationId(c[0].id);});}
  async function newConversation(){await run(async()=>{const c=await api('/v1/conversations','POST',{title:'新的对话'});setConversationId(c.id);await refresh();});}
  async function send(e:FormEvent){
    e.preventDefault();if(!message.trim()||sending||requests.some(active))return;
    const text=message.trim();setSending(true);setError('');
    try{
      let id=conversationId;
      if(!id){const c=await api('/v1/conversations','POST',{title:text.slice(0,24)});id=c.id;currentConversation.current=id;setConversationId(id);}
      const requestId=crypto.randomUUID();
      const accepted=await api(`/v1/conversations/${id}/messages`,'POST',{request_id:requestId,message:text,origin_device_id:origin||null,target_device_id:target||null},{'Idempotency-Key':requestId});
      setMessage('');await loadConversation(id);watch(accepted.request_id);await refresh();
    }catch(e){setError((e as Error).message);}finally{setSending(false);}
  }
  function openMemory(item?:Memory){setEditing(item??null);setMemoryForm(item?{title:item.title,content:item.content,scope:item.scope,applicable_device_id:item.applicable_device_id??''}:{title:'',content:'',scope:'global',applicable_device_id:''});setModal('memory');}
  async function saveMemoryForm(e:FormEvent){e.preventDefault();await run(async()=>{
    if(editing)await api(`/v1/memories/${editing.id}`,'PATCH',{title:memoryForm.title,content:memoryForm.content,expected_revision:editing.revision});
    else await api('/v1/memories','POST',{...memoryForm,applicable_device_id:memoryForm.scope==='device'?memoryForm.applicable_device_id:null});
    setModal(null);await refresh();
  });}
  async function showHistory(m:Memory){await run(async()=>{const r=await api(`/v1/memories/${m.id}/revisions`);setEditing(m);setHistory(r.items);setModal('history');});}
  const switchPage=(p:Page)=>{setPage(p);setError('');};
  const filteredMemories=memories.filter(m=>(memoryScope==='all'||m.scope===memoryScope)&&(memoryScope!=='device'||!memoryDevice||m.applicable_device_id===memoryDevice)&&(!search||`${m.title} ${m.content}`.toLowerCase().includes(search.toLowerCase())));
  const taskWaiting=tasks.filter(t=>t.status==='waiting_device').length;

  if(signedIn===null)return <div className="loading"><Brand/><p>连接你的云端助理…</p></div>;
  if(!signedIn)return <main className="login-layout"><section className="login-intro"><Brand/><p className="eyebrow">YOUR PERSONAL CLOUD COMPANION</p><h1>一个助理。<br/>把你的世界<br/><span>连接起来。</span></h1><p>记忆留在云端，交流随你切换。<br/>从一次对话，开始建立长期默契。</p><div className="intro-bottom">PRIVATE SPACE <span>·</span> V0.1</div></section><section className="login-panel"><form onSubmit={login}><span className="eyebrow">WELCOME BACK</span><h2>进入你的工作空间</h2><p className="muted">使用服务器生成的主人访问令牌登录。</p><label>访问令牌<input type="password" autoComplete="current-password" value={token} onChange={e=>setToken(e.target.value)} required placeholder="粘贴你的访问令牌" autoFocus/></label>{error&&<div className="error" role="alert">{error}</div>}<button className="primary login-button" disabled={busy}>{busy?'正在连接…':'进入 AnyLink'}<Icon name="arrow"/></button><p className="login-note">模型密钥保留在服务器。这里需要的是产品访问令牌。</p></form></section></main>;

  return <div className="app-layout">
    <aside className="sidebar"><Brand/><div className="workspace-label">个人工作空间</div><nav aria-label="主导航">{pages.map(p=><button key={p} className={`nav-item ${page===p?'selected':''}`} onClick={()=>switchPage(p)}><Icon name={p}/><span>{names[p]}</span>{p==='tasks'&&taskWaiting>0&&<span className="nav-count">{taskWaiting}</span>}</button>)}</nav><div className="sidebar-note"><span className="small-dot"/><span>同一个助理<br/><small>记忆统一，设备各司其职</small></span></div><footer><span>AnyLink Agent <small>0.1</small></span><button className="icon-button" aria-label="退出登录" onClick={logout}><Icon name="logout" size={18}/></button></footer></aside>
    <main className="main"><header className="topbar"><span>工作空间 <span className="slash">/</span> {names[page]}</span><span className={`connection ${online?'connected':''}`}><span className="small-dot"/>{online?'云端已就绪':'云端连接待就绪'}</span><button className="icon-button mobile-logout" aria-label="退出登录" onClick={logout}><Icon name="logout" size={17}/></button></header>
      <div className="page-heading"><div><p className="eyebrow">{page==='chat'?'A CONVERSATION THAT CONTINUES':page==='memories'?'A MEMORY THAT GROWS':page==='devices'?'ONE ASSISTANT, MANY PLACES':'THOUGHTS INTO ACTION'}</p><h1>{names[page]}</h1><p>{subtitles[page]}</p></div><div className="heading-actions">{page==='chat'?<button className="secondary" onClick={()=>void newConversation()} disabled={busy||sending}><Icon name="plus" size={17}/>新的对话</button>:<button className="primary" onClick={()=>{if(page==='memories')openMemory();if(page==='devices'){setDeviceForm({name:'',platform:'macos'});setModal('device');}if(page==='tasks'){setTaskForm({goal:'',target_device_id:devices[0]?.id??'',origin_device_id:origin});setModal('task');}}} disabled={busy||(page==='tasks'&&!devices.length)}><Icon name="plus" size={17}/>{page==='memories'?'添加记忆':page==='devices'?'添加设备':'保存任务'}</button>}</div></div>
      {error&&<div className="error page-error" role="alert">{error}<button aria-label="关闭错误" onClick={()=>setError('')}>×</button></div>}

      {page==='chat'&&<section className="chat-shell"><div className="chat-settings"><label>会话<select aria-label="选择会话" value={conversationId} onChange={e=>setConversationId(e.target.value)}>{!conversationId&&<option value="">开始新的对话</option>}{conversations.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}</select></label><label>来源设备<select aria-label="来源设备" value={origin} onChange={e=>setOrigin(e.target.value)}><option value="">未声明</option>{devices.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label><label>任务目标<select aria-label="任务目标" value={target} onChange={e=>setTarget(e.target.value)}><option value="">按对话确定</option>{devices.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label></div>
        <div className="chat-messages">{requests.length===0?<div className="chat-welcome"><span className="assistant-orbit"><Icon name="link" size={34}/></span><span className="eyebrow">HELLO, I'M ANYLINK</span><h2>今天，从哪里开始？</h2><p>聊聊你的想法，或明确告诉我一件需要记住的事。</p><div className="suggestions">{['你能帮我做什么？','记住，我喜欢简洁的中文回复。','看看我有哪些设备。'].map(s=><button key={s} onClick={()=>setMessage(s)}>{s}<Icon name="arrow" size={15}/></button>)}</div></div>:requests.map(r=><div className="exchange" key={r.id}><div className="message user-message"><div className="message-label">你 <time>{date(r.created_at)}</time></div><div className="message-content">{r.message}</div></div><div className="message assistant-message"><div className="message-label"><span className="mini-mark">a.</span>AnyLink<span className={`request-state ${r.state==='submission_unknown'?'unknown':''}`}>{requestNames[r.state]??r.state}</span></div><div className="message-content">{r.response_text||<span className="thinking">{active(r)?'正在连接想法…':'本次没有完整回复。'}</span>}</div>{r.state==='submission_unknown'&&<div className="notice compact">这次运行结果尚未确认，系统不会自动重发。已保存的记忆和任务可以在对应页面核对。<small>编号 {r.id.slice(0,8)} · {r.error_code}</small></div>}</div></div>)}<div ref={bottom}/></div>
        <form className="composer" onSubmit={send}><textarea aria-label="发送消息" value={message} onChange={e=>setMessage(e.target.value)} placeholder="告诉我你的想法…" rows={2} maxLength={16000} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form?.requestSubmit();}}}/><div className="composer-footer"><span>{activity||'DeepSeek Flash · 文字交流'}</span><button className="send-button" aria-label="发送" disabled={sending||requests.some(active)||!message.trim()}><Icon name="arrow" size={19}/></button></div></form><div className="chat-footnote">设备操作尚未接入；任务仅保存并等待。明确说“记住”时，助理才会写入记忆。</div></section>}

      {page==='memories'&&<section><div className="list-toolbar"><div className="tabs">{[['all','全部'],['global','全局记忆'],['device','设备记忆']].map(([id,label])=><button key={id} className={memoryScope===id?'active':''} onClick={()=>setMemoryScope(id)}>{label}</button>)}</div>{memoryScope==='device'&&<select className="memory-device-filter" aria-label="筛选设备记忆" value={memoryDevice} onChange={e=>setMemoryDevice(e.target.value)}><option value="">全部设备</option>{devices.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select>}<input className="search" aria-label="搜索记忆" placeholder="搜索记忆内容…" value={search} onChange={e=>setSearch(e.target.value)}/></div><div className="section-meta">{filteredMemories.length} 条当前有效记忆 <span>· 按最近更新排序</span></div>{!filteredMemories.length?<div className="empty"><Icon name="memories" size={36}/><h2>{search?'没有匹配的记忆':'把重要的事留在这里'}</h2><p>添加全局偏好，或为某台设备保存专属规则。</p><button className="secondary" onClick={()=>openMemory()}>添加第一条记忆</button></div>:<div className="memory-list">{filteredMemories.map(m=><article className="memory-row" key={m.id}><div className="memory-type">{m.scope==='global'?'全局':'设备'}<small>v{m.revision}</small></div><div className="memory-body"><h3>{m.title}</h3><p>{m.content}</p><div className="item-meta">{m.scope==='global'?'跨设备通用':m.device_name??'设备记忆'}<span>·</span>{date(m.updated_at)}</div></div><div className="row-actions"><button onClick={()=>openMemory(m)}>更正</button><button onClick={()=>void showHistory(m)}>历史</button><button className="danger-text" onClick={()=>{if(confirm(`删除“${m.title}”？删除后将不再作为当前记忆召回。`))void run(async()=>{await api(`/v1/memories/${m.id}`,'DELETE',undefined,{'If-Match':String(m.revision)});await refresh();});}}>删除</button></div></article>)}</div>}<p className="section-note">设备目录引用当前事实与版本；更正和删除后，下一次召回直接读取最新内容。</p></section>}

      {page==='devices'&&<section><div className="notice"><Icon name="devices"/><div><strong>先登记设备，再连接执行器</strong><p>这里是你手工声明的逻辑设备。当前不会远程操作电脑或手机，也不代表已建立可信配对。</p></div></div><div className="device-grid">{devices.map(d=><article className="device-card" key={d.id}><div className="device-card-top"><span className="device-symbol">{d.platform==='macos'?'M':d.platform==='android'?'A':'D'}</span><span className="badge">执行器待接入</span></div><h2>{d.name}</h2><p>{platformNames[d.platform]} · 逻辑设备</p><div className="device-memory-count">{memories.filter(m=>m.applicable_device_id===d.id).length}<span>条设备记忆</span></div><button className="text-link" onClick={()=>{setMemoryScope('device');setMemoryDevice(d.id);setSearch('');switchPage('memories');}}>查看设备记忆<Icon name="arrow" size={16}/></button><code>{d.id.slice(0,8)}</code></article>)}<button className="add-device" onClick={()=>{setDeviceForm({name:'',platform:'macos'});setModal('device');}}><Icon name="plus" size={28}/><span>添加逻辑设备</span><small>Mac、Android 或其他设备</small></button></div></section>}

      {page==='tasks'&&<section><div className="notice"><Icon name="tasks"/><div><strong>先保存意图，让任务有处可寻</strong><p>执行器尚未接入。所有新任务都会等待，不会在服务器或其他设备上自动执行。</p></div></div><div className="section-meta">{taskWaiting} 项等待接入 <span>· {tasks.length} 项已保存任务</span></div>{!tasks.length?<div className="empty"><Icon name="tasks" size={36}/><h2>给下一件事一个位置</h2><p>{devices.length?'选择目标设备，保存一项待办任务。':'先添加逻辑设备，再为它保存任务。'}</p><button className="secondary" onClick={()=>switchPage('devices')}>查看设备</button></div>:<div className="task-list">{tasks.map(t=><article className="task-row" key={t.id}><span className={`task-indicator ${t.status==='cancelled'?'cancelled':''}`}/><div className="task-body"><h3>{t.goal}</h3><p>{t.origin_name??'未声明来源'}<span className="route-arrow">→</span>{t.target_name}<span className="meta-separator">·</span>{date(t.created_at)}</p></div><span className={`badge ${t.status==='cancelled'?'neutral':''}`}>{t.status==='cancelled'?'已取消':'等待执行器接入'}</span>{t.status==='waiting_device'&&<button className="small-button" disabled={busy} onClick={()=>void run(async()=>{await api(`/v1/tasks/${t.id}/cancel`,'POST',{});await refresh();})}>取消</button>}</article>)}</div>}</section>}
    </main>

    {modal&&<div className="modal-backdrop" onClick={e=>{if(e.target===e.currentTarget&&!busy)setModal(null);}}><section className="modal" role="dialog" aria-modal="true" aria-label={modal==='memory'?'编辑记忆':modal==='device'?'添加设备':modal==='task'?'保存任务':'修订历史'}><button className="modal-close" aria-label="关闭对话框" onClick={()=>setModal(null)}>×</button>
      {modal==='memory'&&<form onSubmit={saveMemoryForm}><p className="eyebrow">MEMORY</p><h2>{editing?'更正记忆':'添加一条记忆'}</h2><label>主题<input value={memoryForm.title} onChange={e=>setMemoryForm({...memoryForm,title:e.target.value})} maxLength={120} required autoFocus/></label><label>内容<textarea value={memoryForm.content} onChange={e=>setMemoryForm({...memoryForm,content:e.target.value})} rows={5} maxLength={4000} required/></label><label>适用范围<select value={memoryForm.scope} disabled={!!editing} onChange={e=>setMemoryForm({...memoryForm,scope:e.target.value})}><option value="global">全局 · 跨设备通用</option><option value="device">设备 · 仅适用于指定设备</option></select></label>{memoryForm.scope==='device'&&<label>适用设备<select value={memoryForm.applicable_device_id} disabled={!!editing} onChange={e=>setMemoryForm({...memoryForm,applicable_device_id:e.target.value})} required><option value="">选择设备</option>{devices.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}<p className="form-note">{editing?`当前版本 v${editing.revision}。保存时会检查是否被其他窗口修改。`:'直接保存为当前有效记忆，后续可查看历史和更正。'}</p><button className="primary" disabled={busy}>{busy?'正在保存…':'保存记忆'}</button></form>}
      {modal==='device'&&<form onSubmit={e=>{e.preventDefault();void run(async()=>{await api('/v1/devices','POST',deviceForm);setModal(null);await refresh();});}}><p className="eyebrow">DEVICE</p><h2>添加逻辑设备</h2><label>设备名称<input value={deviceForm.name} onChange={e=>setDeviceForm({...deviceForm,name:e.target.value})} placeholder="例如：我的 Mac" maxLength={80} required autoFocus/></label><label>平台<select value={deviceForm.platform} onChange={e=>setDeviceForm({...deviceForm,platform:e.target.value})}><option value="macos">Mac</option><option value="android">Android</option><option value="other">其他</option></select></label><p className="form-note">此步骤只登记设备与记忆归属，不启用远程执行。</p><button className="primary" disabled={busy}>保存设备</button></form>}
      {modal==='task'&&<form onSubmit={e=>{e.preventDefault();void run(async()=>{await api('/v1/tasks','POST',{...taskForm,origin_device_id:taskForm.origin_device_id||null});setModal(null);await refresh();});}}><p className="eyebrow">TASK</p><h2>保存一项任务</h2><label>要做什么<textarea rows={4} value={taskForm.goal} onChange={e=>setTaskForm({...taskForm,goal:e.target.value})} maxLength={2000} required autoFocus/></label><label>目标设备<select value={taskForm.target_device_id} onChange={e=>setTaskForm({...taskForm,target_device_id:e.target.value})} required><option value="">选择设备</option>{devices.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label><label>来源设备<select value={taskForm.origin_device_id} onChange={e=>setTaskForm({...taskForm,origin_device_id:e.target.value})}><option value="">未声明</option>{devices.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label><p className="form-note">保存后等待执行器接入，不会立即操作设备。</p><button className="primary" disabled={busy}>保存待办</button></form>}
      {modal==='history'&&<><p className="eyebrow">REVISION HISTORY</p><h2>{editing?.title}</h2><div className="history-list">{history.map(h=><article key={h.revision}><div className="item-meta">v{h.revision}<span>·</span>{date(h.created_at)}</div><h3>{h.snapshot.title}</h3><p>{h.snapshot.content}</p></article>)}</div></>}
      {error&&<div className="error" role="alert">{error}</div>}
    </section></div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App/>);
