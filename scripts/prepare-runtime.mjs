import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const folder=fs.mkdtempSync(path.resolve('artifacts/runtime-'));
try {
  for(const name of ['package.json','package-lock.json'])fs.copyFileSync(name,path.join(folder,name));
  const result=spawnSync('npm',['ci','--prefix',folder,'--omit=dev','--ignore-scripts','--offline','--no-audit','--no-fund'],{stdio:'inherit'});
  if(result.status!==0)throw new Error('Populate the npm cache with npm ci before preparing runtime dependencies');
  function inspect(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    const p=path.join(dir,e.name);
    if(e.isDirectory())inspect(p);
    else if(e.isFile()&&e.name.endsWith('.node'))throw new Error('Native dependency needs a Linux build; refusing to copy a host binary');
    else if(e.isFile()&&e.name==='package.json'){
      const pkg=JSON.parse(fs.readFileSync(p,'utf8'));
      if(Array.isArray(pkg.os)&&!pkg.os.includes('linux')&&!pkg.os.includes('any'))throw new Error(`Non-Linux runtime dependency: ${pkg.name}`);
      if(Array.isArray(pkg.cpu)&&!pkg.cpu.includes('x64')&&!pkg.cpu.includes('any'))throw new Error(`Non-amd64 runtime dependency: ${pkg.name}`);
    }
  }}
  inspect(path.join(folder,'node_modules'));
  fs.rmSync('dist/runtime-node_modules',{recursive:true,force:true});
  fs.renameSync(path.join(folder,'node_modules'),'dist/runtime-node_modules');
  console.log('Prepared integrity-checked JavaScript-only production dependencies; no host native binaries.');
} finally {fs.rmSync(folder,{recursive:true,force:true});}
