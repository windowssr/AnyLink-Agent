import {validateConnection, AgentFailure} from '../core/protocol.mjs';
const key = 'anylink.binding.encrypted.v1', alias = 'com.anylink.agent.binding.v1';
let temporary;
function cryptoBox() {
  if (typeof plus === 'undefined' || !plus.android) return null;
  const java = plus.android, J = name => java.importClass(name), call = (object, method, ...args) => java.invoke(object, method, ...args);
  const store = J('java.security.KeyStore').getInstance('AndroidKeyStore'); call(store, 'load', null, null);
  let secret = call(store, 'getKey', alias, null);
  if (!secret) {
    const generator = J('javax.crypto.KeyGenerator').getInstance('AES', 'AndroidKeyStore');
    const builder = java.newObject('android.security.keystore.KeyGenParameterSpec$Builder', alias, 3);
    call(builder, 'setBlockModes', ['GCM']); call(builder, 'setEncryptionPaddings', ['NoPadding']);
    call(generator, 'init', call(builder, 'build')); secret = call(generator, 'generateKey');
  }
  const Base64 = J('android.util.Base64'), Cipher = J('javax.crypto.Cipher');
  return {
    seal(value) {
      const cipher = Cipher.getInstance('AES/GCM/NoPadding'); call(cipher, 'init', 1, secret);
      const text = java.newObject('java.lang.String', JSON.stringify(value));
      const data = call(cipher, 'doFinal', call(text, 'getBytes', 'UTF-8'));
      return {version: 1, iv: String(Base64.encodeToString(call(cipher, 'getIV'), 2)), data: String(Base64.encodeToString(data, 2))};
    },
    open(value) {
      if (value.version !== 1) throw new Error('Unsupported vault format');
      const cipher = Cipher.getInstance('AES/GCM/NoPadding');
      const spec = java.newObject('javax.crypto.spec.GCMParameterSpec', 128, Base64.decode(value.iv, 2));
      call(cipher, 'init', 2, secret, spec);
      const data = call(cipher, 'doFinal', Base64.decode(value.data, 2));
      return JSON.parse(String(java.newObject('java.lang.String', data, 'UTF-8')));
    },
  };
}
export const vault = {
  load() {
    const encrypted = uni.getStorageSync(key); if (!encrypted) return temporary ?? null;
    try { const box = cryptoBox(); return box ? validateConnection(box.open(encrypted)) : null; }
    catch { throw new AgentFailure('VAULT_LOCKED', '这台手机无法解密原设备连接，请重新导入；不会降级为明文保存'); }
  },
  save(value) {
    value = validateConnection(value);
    try {
      const box = cryptoBox();
      if (!box) { temporary = value; return {persistent: false}; }
      const encrypted = box.seal(value), recovered = validateConnection(box.open(encrypted));
      if (recovered.token !== value.token || recovered.device_id !== value.device_id) throw new Error('Vault round trip failed');
      uni.setStorageSync(key, encrypted); temporary = value; return {persistent: true};
    } catch { throw new AgentFailure('VAULT_UNAVAILABLE', '设备安全存储不可用，连接信息未保存'); }
  },
};
