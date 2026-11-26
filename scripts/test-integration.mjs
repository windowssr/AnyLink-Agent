import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
let url=process.env.TEST_DATABASE_URL;
if(!url&&fs.existsSync('secrets/integration.json'))url=JSON.parse(fs.readFileSync('secrets/integration.json','utf8')).database_url;
if(!url||new URL(url).pathname!=='/anylink_test')throw new Error('Set TEST_DATABASE_URL to the dedicated anylink_test database');
const result=spawnSync(process.execPath,['--import','tsx','--test','--test-concurrency=1','tests/core.test.ts','tests/plugin.test.ts','tests/speech.test.ts','tests/integration.test.ts','tests/link.test.ts','tests/migration.test.ts','tests/v3.test.ts'],{stdio:'inherit',env:{...process.env,TEST_DATABASE_URL:url}});
process.exit(result.status??1);
