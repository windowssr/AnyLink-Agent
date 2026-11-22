import path from 'node:path';
import {createRequire} from 'node:module';
const plugins = process.env.UNI_HBUILDERX_PLUGINS ?? process.env.HBUILDERX_PLUGINS ?? '/Applications/HBuilderX.app/Contents/HBuilderX/plugins';
const require = createRequire(path.join(plugins, 'uniapp-cli-vite/package.json'));
const module = require('@dcloudio/vite-plugin-uni');
const uni = module.default ?? module;
export default {plugins: [uni()]};
