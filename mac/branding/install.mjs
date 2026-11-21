import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {paths} from '../configure.mjs';
const files=['avatar.png','favicon-32.png','apple-touch-icon.png'];
fs.rmSync(path.join(paths.root,'data/mac/branding/disabled'),{force:true});
if(process.argv.includes('--regenerate')||files.some(file=>!fs.existsSync(path.join(paths.root,'data/mac/branding',file))))execFileSync(process.execPath,[path.join(paths.root,'mac/branding/render.mjs')],{stdio:'inherit'});
execFileSync(process.execPath,[path.join(paths.root,'mac/branding/apply.mjs')],{stdio:'inherit'});
