import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),folder=path.join(root,'mac/companion');
const lock=JSON.parse(fs.readFileSync(path.join(folder,'runtime-lock.json'),'utf8'));
const hash=(data,algorithm='sha256')=>createHash(algorithm).update(data).digest('hex');
for(const item of lock.renderer)assert.equal(hash(fs.readFileSync(path.join(folder,'vendor',item.file))),item.sha256,item.file);
assert.equal(hash(fs.readFileSync(path.join(folder,'vendor',lock.compatibility.file))),lock.compatibility.sha256);
assert.equal(lock.model.redistribute,false);
assert.match(lock.model.commit,/^[a-f0-9]{40}$/);assert.match(lock.core.commit,/^[a-f0-9]{40}$/);
const privateAssets=path.join(root,'data/mac/companion');
if(process.argv.includes('--installed')){
  for(const item of lock.model.files){
    const data=fs.readFileSync(path.join(privateAssets,'model',item.path));
    assert.equal(data.length,item.bytes);assert.equal(hash(Buffer.concat([Buffer.from(`blob ${data.length}\0`),data]),'sha1'),item.blob,item.path);
  }
  assert.equal(hash(fs.readFileSync(path.join(privateAssets,'runtime/live2dcubismcore.min.js'))),lock.core.sha256);
  const entry=JSON.parse(fs.readFileSync(path.join(privateAssets,'model/entry.model3.json'),'utf8'));
  for(const [group,motions] of Object.entries(entry.FileReferences.Motions)){
    assert.ok(['Idle','Wave','WaveReturn','Point','PointReturn'].includes(group));
    for(const item of motions)assert.ok(lock.model.files.some(file=>file.path===item.File)||(group==='Idle'&&item.File==='anylink-idle.motion3.json'));
  }
  assert.equal(hash(fs.readFileSync(path.join(privateAssets,'model/anylink-idle.motion3.json'))),hash(fs.readFileSync(path.join(folder,'idle.motion3.json'))));
}
const bundle=path.join(root,'artifacts/desktop/AnyLink.app/Contents/Resources/CompanionRenderer');
if(fs.existsSync(bundle)){
  const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(item=>item.isDirectory()?walk(path.join(dir,item.name)):[item.name]);
  const names=walk(bundle);
  assert.ok(!names.some(name=>/\.(moc3|png)$/.test(name)||name==='live2dcubismcore.min.js'),'Restricted model and Core must stay outside app bundle');
}
console.log('PASS: pinned MIT renderer hashes, model provenance, safe motion references and private-asset bundle boundary');
