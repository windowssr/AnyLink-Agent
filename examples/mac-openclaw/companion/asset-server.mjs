import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

// An ephemeral, loopback-only static server for WebGL textures. No model API,
// credentials, commands, WebSocket proxy, write route or directory listing.
const [webRoot,modelRoot,coreRoot]=process.argv.slice(2).map(value=>fs.realpathSync(value));
const token=process.env.ANYLINK_AVATAR_ASSET_TOKEN;
if(!token||!/^[a-f0-9]{64}$/.test(token))throw new Error('Missing scoped asset token');
const roots={web:webRoot,model:modelRoot,core:coreRoot};
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.moc3':'application/octet-stream','.md':'text/plain; charset=utf-8'};
const server=http.createServer((req,res)=>{
  try{
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
    const pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname),parts=pathname.split('/').filter(Boolean);
    if(parts.shift()!==token){res.writeHead(404);res.end();return;}
    const root=roots[parts.shift()];if(!root||parts.some(part=>part==='..'||part==='.'||part.includes('\0'))){res.writeHead(404);res.end();return;}
    const file=fs.realpathSync(path.join(root,...parts));
    if(!file.startsWith(root+path.sep)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
    const headers={'Content-Type':mime[path.extname(file)]??'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'private, max-age=3600','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'none'; frame-ancestors 'none'; base-uri 'none'"};
    res.writeHead(200,{...headers,'Content-Length':fs.statSync(file).size});
    if(req.method==='HEAD')res.end();else fs.createReadStream(file).on('error',()=>res.destroy()).pipe(res);
  }catch{res.writeHead(404);res.end();}
});
server.requestTimeout=15000;server.headersTimeout=10000;
server.listen(0,'127.0.0.1',()=>{console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}/${token}/web/index.html`}));});
const stop=()=>{server.closeAllConnections();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),1000).unref();};
process.stdin.resume();process.stdin.on('end',stop);process.on('SIGTERM',stop);process.on('SIGINT',stop);
