import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {root, home} from './layout.mjs';
const web = path.join(home,'web'), companion = path.join(root,'examples/mac-openclaw/companion');
const publicMode=process.argv.includes('--public'),port=publicMode?5182:5181;
const assets = new Map([
  ['/avatar/pixi.min.js',path.join(companion,'vendor/pixi.min.js')],
  ['/avatar/cubism4-colors.min.js',path.join(companion,'vendor/cubism4-colors.min.js')],
  ['/avatar/live2dcubismcore.min.js',path.join(root,'data/mac/companion/runtime/live2dcubismcore.min.js')],
]);
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.png':'image/png','.moc3':'application/octet-stream'};
const server = http.createServer((req,res) => {
  if(req.headers.host!==`127.0.0.1:${port}`||!['GET','HEAD'].includes(req.method)){res.writeHead(403).end();return;}
  let route;try{route=decodeURIComponent(new URL(req.url,`http://127.0.0.1:${port}`).pathname);}catch{res.writeHead(400).end();return;}
  if(publicMode&&(assets.has(route)||route.startsWith('/avatar/model/'))){res.writeHead(404).end();return;}
  let file=assets.get(route);
  if(!file){
    const model=route.startsWith('/avatar/model/'),base=model?path.join(root,'data/mac/companion/model'):web;
    const name=model?route.slice('/avatar/model/'.length):({'/':'preview.html','/avatar/portrait.html':publicMode?'public-portrait.html':'portrait.html','/avatar/avatar.js':'avatar.js','/avatar/public-avatar.js':'public-avatar.js'}[route]??route.slice(1));
    file=path.resolve(base,name);if(!file.startsWith(base+path.sep)){res.writeHead(403).end();return;}
  }
  if(!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
  res.writeHead(200,{'Content-Type':types[path.extname(file)]??'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Length':fs.statSync(file).size});
  if(req.method==='HEAD')res.end();else fs.createReadStream(file).pipe(res);
});
server.listen(port,'127.0.0.1',()=>console.log(`AnyLink Android character preview: http://127.0.0.1:${port}/ (visual states only; no microphone or model calls)`));
