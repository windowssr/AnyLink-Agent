import path from 'node:path';
import fs from 'node:fs';
import {root,home} from './layout.mjs';
import {downloadPinned} from './download.mjs';
const lock=JSON.parse(fs.readFileSync(path.join(home,'offline-asr-lock.json'),'utf8'));
await downloadPinned(lock.runtime,path.join(root,'data/android-native/offline-asr',`sherpa-onnx-${lock.runtime.version}.aar`));
