import fs from 'node:fs';import {randomBytes} from 'node:crypto';
if(fs.existsSync('.env')||fs.existsSync('secrets/local-dev-owner-token'))throw new Error('Preserving existing local configuration; configure it manually or use a separate checkout');
const password=randomBytes(32).toString('base64url'),owner=randomBytes(36).toString('base64url');
fs.mkdirSync('secrets',{recursive:true,mode:0o700});
fs.writeFileSync('.env',`DATABASE_URL=postgresql://anylink:${password}@127.0.0.1:54329/anylink\nDB_PASSWORD=${password}\nOWNER_TOKEN=${owner}\nDEEPSEEK_API_KEY=${process.env.DEEPSEEK_API_KEY??''}\nDEEPSEEK_BASE_URL=https://api.deepseek.com/v1\nAPP_ORIGIN=http://127.0.0.1:3180\nHOST=127.0.0.1\nPORT=3180\n`,{mode:0o600,flag:'wx'});
fs.writeFileSync('secrets/local-dev-owner-token',owner+'\n',{mode:0o600,flag:'wx'});
console.log('Created private .env and secrets/local-dev-owner-token. Configure DEEPSEEK_API_KEY only if using model passthrough; memory and tasks work without it. No secrets were printed.');
