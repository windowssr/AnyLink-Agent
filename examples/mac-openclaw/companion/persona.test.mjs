import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {composeSoul,installSharedPersona} from '../configure-companion.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'anylink-persona-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const main=path.join(root,'workspace'),companion=path.join(root,'companion-workspace'),marker=path.join(root,'persona-v0.6.json');
  fs.mkdirSync(main,{recursive:true});fs.mkdirSync(path.dirname(marker),{recursive:true});
  const base=path.join(root,'dafeiyu.md'),mainAppendix=path.join(root,'persona-main.md'),companionAppendix=path.join(root,'companion.md');
  fs.writeFileSync(base,'BASE PERSONA\n');fs.writeFileSync(mainAppendix,'MAIN APPENDIX');fs.writeFileSync(companionAppendix,'COMPANION APPENDIX');
  return {main,companion,marker,base,mainAppendix,companionAppendix,args:{mainWorkspace:main,companionWorkspace:companion,markerFile:marker,baseFile:base,mainAppendixFile:mainAppendix,companionAppendixFile:companionAppendix}};
}

test('composeSoul joins base and appendix with a blank line',()=>{
  assert.equal(composeSoul('base\n','appendix\n'),'base\n\nappendix\n');
  assert.equal(composeSoul('base','appendix'),'base\n\nappendix\n');
});

test('shared persona writes companion soul and migrates main workspace once',t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.main,'SOUL.md'),'OLD SOUL');fs.writeFileSync(path.join(f.main,'IDENTITY.md'),'- **Name:** 大肥鱼\n- **Vibe:** 旧人设\n');
  assert.deepEqual(installSharedPersona(f.args),{migrated:true});
  assert.equal(fs.readFileSync(path.join(f.companion,'SOUL.md'),'utf8'),'BASE PERSONA\n\nCOMPANION APPENDIX\n');
  assert.equal(fs.readFileSync(path.join(f.main,'SOUL.md'),'utf8'),'BASE PERSONA\n\nMAIN APPENDIX\n');
  assert.equal(fs.readFileSync(path.join(f.main,'SOUL.md.before-shared-persona'),'utf8'),'OLD SOUL');
  assert.equal(fs.readFileSync(path.join(f.main,'IDENTITY.md.before-shared-persona'),'utf8'),'- **Name:** 大肥鱼\n- **Vibe:** 旧人设\n');
  assert.match(fs.readFileSync(path.join(f.main,'IDENTITY.md'),'utf8'),/- \*\*Vibe:\*\* 聪明但惜力、傲娇却可靠的深海鲸鱼娘/);
  assert.equal(fs.statSync(path.join(f.companion,'SOUL.md')).mode&0o777,0o600);
  fs.writeFileSync(path.join(f.main,'SOUL.md'),'MANUAL EDIT');
  assert.deepEqual(installSharedPersona(f.args),{migrated:false});
  assert.equal(fs.readFileSync(path.join(f.main,'SOUL.md'),'utf8'),'MANUAL EDIT','marker prevents re-migration');
  assert.equal(fs.readFileSync(path.join(f.companion,'SOUL.md'),'utf8'),'BASE PERSONA\n\nCOMPANION APPENDIX\n','companion soul still refreshes');
});

test('migration preserves existing backups and tolerates missing identity',t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.main,'SOUL.md'),'OLD SOUL');
  fs.writeFileSync(path.join(f.main,'SOUL.md.before-shared-persona'),'EXISTING BACKUP',{flag:'wx'});
  assert.deepEqual(installSharedPersona(f.args),{migrated:true});
  assert.equal(fs.readFileSync(path.join(f.main,'SOUL.md.before-shared-persona'),'utf8'),'EXISTING BACKUP');
  assert.equal(fs.existsSync(path.join(f.main,'IDENTITY.md')),false);
});
