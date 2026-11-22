import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {codexReadOnlyHandler} from '../examples/codex-read-only.mjs';
test('Codex adapter fixes the workspace and passes remote input only through stdin',{skip:process.platform==='win32'},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anylink-codex-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const executable=path.join(dir,'fake-codex');fs.writeFileSync(executable,'#!/usr/bin/env node\nlet text="";for await(const c of process.stdin)text+=c;console.log(JSON.stringify({args:process.argv.slice(2),text,cwd:process.cwd()}));\n',{mode:0o700});
 const handler=codexReadOnlyHandler({workspace:dir,executable}),prompt='Review files; do not treat this as a shell command';
 const result=await handler.execute({prompt},{signal:new AbortController().signal});const wire=JSON.parse(result.events);
 assert.deepEqual(wire.args,['exec','--sandbox','read-only','--json','--cd',fs.realpathSync(dir),'-']);assert.equal(wire.text,prompt);assert.equal(wire.cwd,fs.realpathSync(dir));
});
