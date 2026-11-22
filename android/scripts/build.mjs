import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugins = process.env.HBUILDERX_PLUGINS ?? '/Applications/HBuilderX.app/Contents/HBuilderX/plugins';
const compiler = path.join(plugins, 'uniapp-cli-vite/node_modules/@dcloudio/vite-plugin-uni/bin/uni.js');
if (!fs.existsSync(compiler)) throw new Error('Install HBuilderX with the uni-app Vue 3 compiler, or set HBUILDERX_PLUGINS.');
// Reuse the installed compiler's matching DCloud runtime instead of downloading
// another compiler. npm ci may remove these links; every build recreates them.
const vendor = path.join(plugins, 'uniapp-cli-vite/node_modules/@dcloudio'), modules = path.join(root, 'node_modules/@dcloudio');
fs.mkdirSync(modules, {recursive: true});
for (const name of fs.readdirSync(vendor)) {
  const target = path.join(modules, name);
  if (!fs.existsSync(target)) fs.symlinkSync(path.join(vendor, name), target, 'dir');
}
const platform = process.argv.includes('--app') ? 'app' : 'h5';
const output = path.join(root, 'unpackage', 'dist', 'build', platform === 'app' ? 'app-plus' : 'h5');
fs.rmSync(output, {recursive: true, force: true});
const result = spawnSync(process.execPath, [compiler, 'build', '-p', platform], {cwd: root, stdio: 'inherit', env: {...process.env, UNI_PROJECT_TYPE: 'hbuilder', ...(platform === 'app' ? {UNI_APP_PLATFORM: 'android'} : {}), UNI_INPUT_DIR: root, UNI_OUTPUT_DIR: output, UNI_CLI_CONTEXT: root, UNI_HBUILDERX_PLUGINS: plugins}});
if (result.error) throw result.error;
if (result.status === 0 && !fs.existsSync(path.join(output, platform === 'app' ? 'app-service.js' : 'index.html'))) throw new Error('Compiler did not produce the expected entry; build is not successful.');
process.exitCode = result.status ?? 1;
