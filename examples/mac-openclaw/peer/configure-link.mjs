import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {paths} from '../configure.mjs';
const {values}=parseArgs({options:{workspace:{type:'string'}}});
const connection=JSON.parse(fs.readFileSync(paths.connection,'utf8'));
const file=path.join(paths.root,'secrets/mac-peer-policy.json');
if(fs.existsSync(file)){
  const current=JSON.parse(fs.readFileSync(file,'utf8'));
  if(current.device_id!==connection.device_id||!current.roots?.length)throw new Error('Existing local search policy needs manual review; it was preserved');
  if(values.workspace)throw new Error('A policy already exists; review its roots locally instead of overwriting them');
  console.log(JSON.stringify({configured:true,preserved_existing_policy:true,capability:'files.search'}));
}else{
  const workspace=fs.realpathSync(values.workspace??paths.workspace);
  if(!fs.statSync(workspace).isDirectory())throw new Error('Choose an existing workspace directory');
  fs.writeFileSync(file,JSON.stringify({version:1,device_id:connection.device_id,name:'Mac',roots:[{id:'workspace',label:'Operator-selected workspace',path:workspace}],peers:[]},null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({configured:true,capability:'files.search',scopes:['workspace'],read_only:true}));
}
