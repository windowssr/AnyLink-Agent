// Run with: node --import tsx examples/android-native/scripts/create-preview-audio.mjs
import fs from 'node:fs';import path from 'node:path';import {createSynthesizer} from '../../../server/speech.ts';
const output=path.resolve('artifacts/android-native/preview-speech.mp3');
const audio=await createSynthesizer()('你好，主人。文件已经收到了，点开聊天里的预览就能查看。','sweet-lively');
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,audio);console.log('Prepared local preview speech: '+audio.length+' bytes');
