import {rmSync} from 'node:fs';
// Delete only generated server output, so removed cloud-agent modules cannot ship stale.
rmSync(new URL('../dist/server',import.meta.url),{recursive:true,force:true});
