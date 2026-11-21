import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import plugin from './index.mjs';

test('bundled plugin reads the explicit project root rather than the loader cache',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'anylink-plugin-root-'));
  try{
    fs.mkdirSync(path.join(root,'mac/control'),{recursive:true});fs.writeFileSync(path.join(root,'mac/control/versions.json'),'{}');
    fs.mkdirSync(path.join(root,'data/mac/control'),{recursive:true});fs.writeFileSync(path.join(root,'data/mac/control/control.json'),'{"enabled":true}');
    let factory;plugin.register({pluginConfig:{projectRoot:root},on(){},registerTool(fn){factory=fn;}});
    const status=await factory({runId:'fixture'}).find(t=>t.name==='anylink_mac_status').execute('status',{});
    assert.equal(status.details.enabled,true);assert.equal(status.details.ready,false);
    assert.match(status.details.summary,/安装|响应/);
    assert.throws(()=>plugin.register({pluginConfig:{},on(){},registerTool(){}}),/EXPLICIT_PROJECT_ROOT_REQUIRED/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
