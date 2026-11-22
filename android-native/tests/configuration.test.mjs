import test from 'node:test';
import assert from 'node:assert/strict';
import {configuredPreview,previewAgent} from '../scripts/configuration.mjs';
const fixture=()=>({gateway:{bind:'loopback',port:18791},agents:{entries:{main:{identity:{name:'大肥鱼'}},companion:{tools:{allow:['anylink_companion_expression']}}}},plugins:{allow:['anylink-memory'],entries:{'anylink-memory':{config:{connectionFile:'/private/mac.json',deviceConnections:{existing:{connectionFile:'/private/existing.json'}}}}}}});
test('native preview retains Mac routes and confines Android to separately configured tools and memory',()=>{
  const original=fixture(),c=configuredPreview(original,'/project');
  assert.deepEqual(c.agents.entries.main,original.agents.entries.main);
  assert.deepEqual(c.agents.entries.companion,original.agents.entries.companion);
  assert.deepEqual(c.gateway,original.gateway);
  assert.deepEqual(c.plugins.entries['anylink-memory'].config.deviceConnections.existing,{connectionFile:'/private/existing.json'});
  const android=c.agents.entries[previewAgent];
  assert.equal(android.tools.profile,'full');
  assert.ok(android.tools.allow.includes('nodes'));
  assert.ok(android.tools.allow.includes('mobile_ui'));
  assert.ok(android.tools.allow.includes('ask_user'));
  assert.ok(android.tools.allow.includes('anylink_mac_search_files'));
  assert.ok(!android.tools.allow.includes('exec'));
  assert.ok(!android.tools.allow.includes('anylink_mac_act'));
  assert.ok(!android.tools.allow.includes('anylink_companion_control'));
  assert.equal(c.tts.auto,'off'); // Native Talk owns playback, Mac keeps its own voice.
  assert.equal(c.talk.realtime.mode,'stt-tts');
  assert.deepEqual(configuredPreview(c,'/project'),c);
  assert.equal(original.agents.entries[previewAgent],undefined);
});
test('preview refuses unexpected gateway and incomplete baseline',()=>{
  assert.throws(()=>configuredPreview({...fixture(),gateway:{bind:'lan',port:18791}},'/project'));
  assert.throws(()=>configuredPreview({gateway:{bind:'loopback',port:18791}},'/project'));
});
