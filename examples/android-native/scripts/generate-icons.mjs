import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const home=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const icons={
 mic:['M12 15a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v7a3 3 0 0 0 3 3Z','M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8'],
 'mic-off':['M3 3l18 18M9 9v3a3 3 0 0 0 5 2M9 5a3 3 0 0 1 6 0v5M5 10v2a7 7 0 0 0 12 5M19 10v2M12 19v3M8 22h8'],
 phone:['M8 3H4a1 1 0 0 0-1 1c0 9.4 7.6 17 17 17a1 1 0 0 0 1-1v-4l-5-2-2 2a14 14 0 0 1-6-6l2-2-2-5Z'],
 'phone-off':['M3 15v-4c5-5 13-5 18 0v4h-5v-3a12 12 0 0 0-8 0v3H3Z'],
 speaker:['M11 4 6 8H3v8h3l5 4V4ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14'],
 earpiece:['M8 4a6 6 0 0 1 10 5c0 4-5 4-5 8a3 3 0 0 1-6 0M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4'],
 attachment:['M8 12l6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8a7 7 0 0 1 10 10l-7 7'],
 file:['M14 2H5v20h14V7l-5-5ZM14 2v6h5M8 13h8M8 17h5'],
 image:['M3 3h18v18H3V3ZM3 17l6-6 4 4 3-3 5 5M15 7h1'],
 play:['m9 5 11 7-11 7V5Z'],
 share:['M12 16V3M7 8l5-5 5 5M5 13H3v8h18v-8h-2'],
 close:['M6 6l12 12M18 6 6 18'],
 stop:['M6 6h12v12H6V6Z'],
 send:['m3 3 19 9-19 9 4-9-4-9ZM7 12h15'],
 settings:['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z'],
 tasks:['M8 3h13v18H3V8M3 3l2 2 4-4M8 10h9M8 15h9'],
 chevron:['m6 9 6 6 6-6'],
 check:['m5 12 4 4L19 6'],
};
let drift=false;
for(const [name,paths] of Object.entries(icons)){
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths.map(d=>`<path d="${d}"/>`).join('')}</svg>\n`;
 const vector=`<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">${paths.map(d=>`<path android:fillColor="@android:color/transparent" android:strokeColor="#FF0B2A40" android:strokeWidth="1.8" android:strokeLineCap="round" android:strokeLineJoin="round" android:pathData="${d}"/>`).join('')}</vector>\n`;
 for(const [file,data] of [[path.join(home,'web/icons',name+'.svg'),svg],[path.join(home,'overlay/app/src/main/res/drawable',`anylink_ic_${name.replaceAll('-','_')}.xml`),vector]]){
  if(process.argv.includes('--check')){if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==data){console.error('Icon drift: '+file);drift=true;}}
  else{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);}
 }
}
const sprite='<svg xmlns="http://www.w3.org/2000/svg">'+Object.entries(icons).map(([name,paths])=>`<symbol id="${name}" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths.map(d=>`<path d="${d}"/>`).join('')}</g></symbol>`).join('')+'</svg>\n';
const spriteFile=path.join(home,'web/icons/sprite.svg');
if(process.argv.includes('--check')){if(!fs.existsSync(spriteFile)||fs.readFileSync(spriteFile,'utf8')!==sprite)drift=true;}else fs.writeFileSync(spriteFile,sprite);
if(drift)process.exitCode=1;
