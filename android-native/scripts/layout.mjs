import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const home = path.join(root, 'android-native');
export const lock = JSON.parse(fs.readFileSync(path.join(home, 'upstream-lock.json'), 'utf8'));
export const source = path.join(root, lock.sourceDirectory);
export const tools = JSON.parse(fs.readFileSync(path.join(home, 'toolchain-lock.json'), 'utf8'));
export const sdk = path.join(root, tools.sdkDirectory);
export const output = path.join(root, 'artifacts/android-native');
export const node = path.join(root, 'data/mac/runtime/node_modules/node/bin/node');
export function environment() {
  return {...process.env, JAVA_HOME: tools.javaHome, JAVA_TOOL_OPTIONS: [process.env.JAVA_TOOL_OPTIONS, '-Djava.net.preferIPv4Stack=true'].filter(Boolean).join(' '), ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ANDROID_USER_HOME: path.join(root, 'data/android-native/android-user'), GRADLE_USER_HOME: path.join(root, tools.gradleCacheDirectory), PATH: [path.dirname(node), path.join(tools.javaHome, 'bin'), path.join(sdk, 'platform-tools'), process.env.PATH].join(path.delimiter)};
}
