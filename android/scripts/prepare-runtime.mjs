import {build} from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await build({stdin: {contents: "export {Agent} from '@earendil-works/pi-agent-core';\nexport {AssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';\nexport {getCurrentTools, getCurrentSystemPrompt} from '@earendil-works/pi-ai/utils/transcript';", resolveDir: root, sourcefile: 'anylink-mobile-runtime.js'}, bundle: true, format: 'esm', platform: 'browser', target: 'es2020', minify: true, legalComments: 'linked', outfile: path.join(root, 'runtime/pi-agent.js'), metafile: true}).then(result => {
  const inputs = Object.keys(result.metafile.inputs);
  if (inputs.some(input => input.startsWith('node:'))) throw new Error('Node builtins cannot enter the Android runtime');
  console.log('Bundled pinned Pi Agent core: ' + fs.statSync(path.join(root, 'runtime/pi-agent.js')).size + ' bytes; runs on the device.');
});
