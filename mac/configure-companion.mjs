import fs from 'node:fs';
import path from 'node:path';
import {paths} from './configure.mjs';
const file=path.join(paths.state,'openclaw.json'),config=JSON.parse(fs.readFileSync(file,'utf8'));
if(config.gateway?.port!==18791||config.gateway.bind!=='loopback')throw new Error('Unexpected Mac profile');
const folder=path.join(paths.root,'data/mac/companion'),workspace=path.join(folder,'workspace');
fs.mkdirSync(workspace,{recursive:true,mode:0o700});
fs.copyFileSync(path.join(paths.root,'mac/companion/persona.md'),path.join(workspace,'SOUL.md'));fs.chmodSync(path.join(workspace,'SOUL.md'),0o600);
const identity=path.join(paths.workspace,'IDENTITY.md'),personaMarker=path.join(folder,'persona-v0.5.json');
if(fs.existsSync(identity)&&!fs.existsSync(personaMarker)){
  const original=fs.readFileSync(identity,'utf8'),backup=identity+'.before-desktop-companion';
  if(!fs.existsSync(backup)){fs.writeFileSync(backup,original,{mode:0o600,flag:'wx'});}
  const updated=original.replace(/^- \*\*Vibe:\*\*.*$/m,'- **Vibe:** 办事认真利落，闲下来温柔活泼，喜欢在桌面散步、主动关心主人，有分寸地聊天')
    .replace(/^- \*\*Avatar:\*\*.*$/m,'- **Avatar:** 正常比例的蓝色大肥鱼 Live2D 桌面形象');
  const soul=path.join(paths.workspace,'SOUL.md');
  if(fs.existsSync(soul)){
    const source=fs.readFileSync(soul,'utf8'),name=original.match(/\*\*Name:\*\*\s*([^\n]+)/)?.[1]??'大肥鱼';
    if(source.includes('我是 Window。冷静的观窗者：话少、看得准，先把事情办完再开口。🪟')){
      if(!fs.existsSync(soul+'.before-desktop-companion'))fs.writeFileSync(soul+'.before-desktop-companion',source,{mode:0o600,flag:'wx'});
      fs.writeFileSync(soul,source.replace('我是 Window。冷静的观窗者：话少、看得准，先把事情办完再开口。🪟',`我是${name}。办事认真利落，闲下来温柔活泼，喜欢在桌面散步、主动关心主人，有分寸地聊天。🪟`),{mode:0o600});
    }
  }
  fs.writeFileSync(identity,updated,{mode:0o600});fs.writeFileSync(personaMarker,JSON.stringify({version:'0.5',installed_at:new Date().toISOString()}),{mode:0o600,flag:'wx'});
}
config.plugins.allow=[...new Set([...config.plugins.allow,'anylink-companion'])];
config.plugins.load.paths=[...new Set([...config.plugins.load.paths,path.join(paths.root,'mac/companion/plugin')])];
config.plugins.entries['anylink-companion']={enabled:true,hooks:{allowConversationAccess:true,allowPromptInjection:true,timeoutMs:15000},config:{projectRoot:paths.root}};
config.agents.entries??={main:{default:true}};
// Migrate only this installer's temporary legacy roster; preserve other entries.
if(config.agents.list){for(const {id,...value} of config.agents.list)config.agents.entries[id]??=value;delete config.agents.list;}
config.agents.entries.companion={...config.agents.entries.companion,name:'大肥鱼 · 桌面伙伴',workspace,tools:{allow:['anylink_companion_expression','anylink_companion_control']}};
config.agents.ownership='explicit';config.agents.defaults.systemAgent??={agentId:'main'};
for(const agent of Object.values(config.agents.entries))delete agent.default;
if(fs.existsSync(identity)){
  const text=fs.readFileSync(identity,'utf8'),name=text.match(/\*\*Name:\*\*\s*([^\n]+)/)?.[1],theme=text.match(/\*\*Vibe:\*\*\s*([^\n]+)/)?.[1];
  config.agents.entries.main??={};config.agents.entries.main.identity??={};
  if(name)config.agents.entries.main.identity.name=name;if(theme)config.agents.entries.main.identity.theme=theme;
}
const backup=file+'.before-companion-'+new Date().toISOString().replaceAll(/[:.]/g,'-');fs.copyFileSync(file,backup);fs.chmodSync(backup,0o600);
const temp=file+'.companion-'+process.pid;fs.writeFileSync(temp,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temp,file);
console.log('Configured local companion persona and bounded desktop companion tools. Concurrency and cloud configuration retained.');
