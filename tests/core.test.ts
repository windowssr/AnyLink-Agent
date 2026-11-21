import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical,hash } from '../server/db.js';
import { memorySchema } from '../server/store.js';
test('request hashing preserves content and ignores object ordering',()=>{
  assert.equal(hash(canonical({b:2,a:{z:3,y:4}})),hash(canonical({a:{y:4,z:3},b:2})));
  assert.notEqual(hash(canonical({content:'旧事实'})),hash(canonical({content:'新事实'})));
});
test('memory applicability stays separate from source identity',()=>{
  assert.equal(memorySchema.safeParse({title:'目录',content:'/work',scope:'device'}).success,false);
  assert.equal(memorySchema.safeParse({title:'偏好',content:'中文',scope:'global',applicable_device_id:'00000000-0000-4000-8000-000000000002'}).success,false);
  assert.equal(memorySchema.safeParse({title:'偏好',content:'中文',scope:'global'}).success,true);
});
