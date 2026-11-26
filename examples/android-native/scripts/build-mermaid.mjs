import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {home,source,node} from './layout.mjs';
const dependencies=path.join(home,'renderer/node_modules');
for(const [name,version] of [['vite','8.3.4'],['pele','1.6.0'],['dompurify','3.4.17']]){
  const file=path.join(dependencies,name,'package.json');
  if(!fs.existsSync(file)||JSON.parse(fs.readFileSync(file)).version!==version)throw new Error('Install the isolated pinned renderer dependencies with npm ci --prefix examples/android-native/renderer --ignore-scripts');
}
const directory=path.join(source,'packages/mermaid-renderer'),link=path.join(directory,'node_modules');
let linkStat=null;try{linkStat=fs.lstatSync(link);}catch{}
if(linkStat&&linkStat.isSymbolicLink()&&!fs.existsSync(link))fs.unlinkSync(link);
if(!fs.existsSync(link))fs.symlinkSync(dependencies,link,'dir');
else if(fs.realpathSync(link)!==fs.realpathSync(dependencies))throw new Error('Preserving unrelated Mermaid renderer dependencies');
// Run the original native renderer and Vite config. This retains Pele's sandbox,
// sanitization, offline frame structure and license notices without installing
// the complete OpenClaw workspace or falling through to the product Web Vite.
execFileSync(node,[path.join(dependencies,'vite/bin/vite.js'),'build'],{cwd:directory,stdio:'inherit'});
