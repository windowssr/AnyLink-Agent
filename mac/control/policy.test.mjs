import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {actionArguments,validateApp,workspaceDocument} from './policy.mjs';

const observation=()=>({app:'com.apple.TextEdit',windowId:42,snapshotId:'real-frame',created:Date.now(),used:false,width:100,height:80,scaleX:2,scaleY:2,elements:new Set(['e1','e2'])});
test('input is pinned to the observed exact window and screenshot scale',()=>{
  const args=actionArguments({action:'click',app:'com.apple.TextEdit',x:20,y:30},observation());
  assert.ok(args.includes('42'));assert.ok(args.includes('real-frame'));assert.ok(args.includes('40,60'));assert.ok(!args.includes('--global'));
  const foreground=actionArguments({action:'click',app:'com.apple.TextEdit',x:20,y:30,foreground:true},observation());
  assert.ok(foreground.includes('--foreground'));assert.ok(foreground.includes('--space-switch'));
});
test('stale, consumed and other-app observations refuse input',()=>{
  for(const receipt of [{...observation(),created:Date.now()-46000},{...observation(),used:true},{...observation(),app:'com.apple.Safari'}])assert.throws(()=>actionArguments({action:'click',app:'com.apple.TextEdit',element_id:'e1'},receipt));
});
test('coordinates and element IDs must belong to the delivered observation',()=>{
  for(const input of [{x:-1,y:2},{x:100,y:2},{x:20,y:80},{x:Infinity,y:0},{element_id:'guessed-element'}])assert.throws(()=>actionArguments({action:'click',app:'com.apple.TextEdit',...input},observation()));
});
test('own approvals, security settings and GUI command shells are not controllable',()=>{
  for(const app of ['com.anylink.desktop','boo.peekaboo.mac','com.apple.systempreferences','com.apple.Terminal','COM.APPLE.TERMINAL','com.openai.codex'])assert.throws(()=>validateApp(app));
  for(const app of ['--foreground','/Applications/TextEdit.app','com.apple.TextEdit; touch /tmp/pwn'])assert.throws(()=>validateApp(app));
});
test('a browser showing own approvals and secure focused fields cannot receive input',()=>{
  assert.throws(()=>actionArguments({action:'click',app:'com.apple.TextEdit',element_id:'e1'},{...observation(),protectedSurface:true}));
  assert.throws(()=>actionArguments({action:'type',app:'com.apple.TextEdit',text:'secret'},{...observation(),focusedSecure:true}));
  assert.throws(()=>actionArguments({action:'key',app:'com.apple.TextEdit',key:'cmd+v'},{...observation(),focusedSecure:true}));
});
test('literal content is a single argv value, with CLI backslashes preserved',()=>{
  const args=actionArguments({action:'type',app:'com.apple.TextEdit',text:'$(touch /tmp/pwn) C:\\new\\folder\n你好'},observation());
  assert.equal(args[args.indexOf('--text')+1],'$(touch /tmp/pwn) C:\\\\new\\\\folder\n你好');
  const paste=actionArguments({action:'type',app:'com.apple.TextEdit',text:'你好 AnyLink\\literal',foreground:true},observation());
  assert.equal(paste[0],'paste');assert.equal(paste[paste.indexOf('--text')+1],'你好 AnyLink\\literal');assert.ok(paste.includes('--restore-delay'));assert.ok(!paste.includes('--snapshot'));
  assert.throws(()=>actionArguments({action:'type',app:'com.apple.TextEdit',text:'bad\u001binput'},observation()));
});
test('key and scrolling validation excludes CLI options and unbounded input',()=>{
  for(const key of ['--no-remote','Return --foreground','cmd+q;exec'])assert.throws(()=>actionArguments({action:'key',app:'com.apple.TextEdit',key},observation()));
  assert.ok(actionArguments({action:'key',app:'com.apple.TextEdit',key:'cmd+shift+s'},observation()).includes('cmd+shift+s'));
  assert.throws(()=>actionArguments({action:'scroll',app:'com.apple.TextEdit',direction:'down',amount:100,x:2,y:2},observation()));
});
test('empty foreground text cannot paste unrelated clipboard data',()=>{
  for(const text of ['', ' ', '\n\t'])assert.throws(()=>actionArguments({action:'type',app:'com.apple.TextEdit',text,foreground:true,clear:true},observation()),/EMPTY_FOREGROUND_TEXT/);
});
test('drag is bounded to observed elements in one exact window',()=>{
  assert.throws(()=>actionArguments({action:'drag',app:'com.apple.TextEdit',element_id:'e1',to_element_id:'other-window'},observation()));
  const args=actionArguments({action:'drag',app:'com.apple.TextEdit',element_id:'e1',to_element_id:'e2'},observation());
  assert.ok(args.includes('600ms'));assert.ok(!args.includes('--to-app'));
});
test('focus selects the observed window and verifies the foreground transition',()=>{
  const args=actionArguments({action:'focus',app:'com.apple.TextEdit'},observation());
  assert.equal(args[0],'window');assert.equal(args[1],'focus');assert.ok(args.includes('--verify'));assert.ok(args.includes('42'));assert.ok(!args.includes('--foreground'));assert.ok(!args.includes('--snapshot'));
});
test('opening a workspace document refuses traversal and symlink escape',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anylink-open-test-'));
  try{
    fs.mkdirSync(path.join(dir,'workspace'));fs.writeFileSync(path.join(dir,'workspace','proof.txt'),'proof');fs.writeFileSync(path.join(dir,'private.txt'),'private');
    fs.symlinkSync(path.join(dir,'private.txt'),path.join(dir,'workspace','escape.txt'));
    const workspace=path.join(dir,'workspace');
    assert.equal(workspaceDocument(workspace,'proof.txt'),fs.realpathSync(path.join(workspace,'proof.txt')));
    for(const relative of ['../private.txt','escape.txt',path.join(dir,'private.txt')])assert.throws(()=>workspaceDocument(workspace,relative));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
